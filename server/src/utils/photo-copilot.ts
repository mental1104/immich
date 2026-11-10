import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import z from 'zod';

/** 本机 0.166.0 CLI 生成 Schema 中本功能实际消费的通知子集。 */
export const codexNotificationSchema = z.object({
  method: z.string(),
  params: z.object({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    itemId: z.string().optional(),
    delta: z.string().optional(),
    willRetry: z.boolean().optional(),
    turn: z
      .object({
        id: z.string(),
        status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']),
        error: z.unknown().optional(),
      })
      .optional(),
    item: z.object({ id: z.string(), type: z.string(), text: z.string().optional() }).optional(),
  }),
});

/** 只向服务层公开通知和连接丢失，不允许浏览器发送通用 RPC。 */
export type CodexNotification = z.infer<typeof codexNotificationSchema>;

/** 隔离的 App Server 启动参数；HOME 必须由本功能独占，不得指向现有 NAS/Codex 配置目录。 */
export interface PhotoCodexOptions {
  executable: string;
  home: string;
  cwd: string;
}

/** 每个 API 进程一个 stdio App Server；请求超时/进程退出时统一关闭，避免留下未被 UI 观察的任务。 */
export class PhotoCodexClient extends EventEmitter<{
  notification: [CodexNotification];
  disconnected: [];
}> {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
  >();

  /** @param options 受信任的服务端进程参数；不继承服务端数据库或 SSH 环境变量。 */
  constructor(private options: PhotoCodexOptions) {
    super();
  }

  /** @returns 完成 initialize/initialized 握手；失败后下一次调用可重试。 */
  connect(): Promise<void> {
    this.ready ??= this.initialize().catch((error: unknown) => {
      this.close();
      throw error;
    });
    return this.ready;
  }

  /** @returns 启动隔离子进程并完成官方握手；stderr 不进入应用日志。 */
  private async initialize(): Promise<void> {
    const env: NodeJS.ProcessEnv = { CODEX_HOME: this.options.home };
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP'])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(this.options.executable, ['app-server', '--listen', 'stdio://'], {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    // 不保存 stderr：错误可能回显文件路径、模型输入或认证信息。
    child.stderr.resume();
    child.stdin.on('error', () => this.close());
    const reader = createInterface({ input: child.stdout });
    reader.on('line', (line) => this.receive(line));
    child.on('error', () => this.close());
    child.on('exit', () => {
      if (this.child === child) this.close();
    });
    await this.request(
      'initialize',
      { clientInfo: { name: 'immich_photo_copilot', version: '0.1.0' }, capabilities: { experimentalApi: true } },
      z.unknown(),
    );
    this.write({ method: 'initialized', params: {} });
  }

  /** @param line 单行 JSON-RPC 消息；无效消息关闭连接，所有审批请求均拒绝。 */
  private receive(line: string): void {
    try {
      const message = z
        .object({
          id: z.union([z.string(), z.number()]).optional(),
          method: z.string().optional(),
          result: z.unknown().optional(),
          error: z.unknown().optional(),
        })
        .passthrough()
        .parse(JSON.parse(line));
      if (message.method && message.id !== undefined) {
        this.write({
          id: message.id,
          error: { code: -32_601, message: 'Interactive tools are disabled in Photo Copilot' },
        });
      } else if (typeof message.id === 'number') {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error('Codex rejected the request. Check login, model and CLI version.'));
        else request.resolve(message.result);
      } else {
        const event = codexNotificationSchema.safeParse(message);
        if (event.success) this.emit('notification', event.data);
      }
    } catch {
      this.close();
    }
  }

  /** @param message 向本实例拥有的 stdio 管道写入的消息；断线时抛错。 */
  private write(message: object): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex is disconnected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  /**
   * 发送并校验有界 RPC 请求；30 秒未受理时断开，避免迟到响应创建幽灵任务。
   * @param method 官方 RPC 方法。
   * @param params 与本机 Schema 对照的结构化参数。
   * @param schema 返回结构的运行时边界。
   * @returns 已校验的官方结果；错误信息不包含原始 Codex 输出。
   */
  async request<T>(method: string, params: object, schema: z.ZodType<T>): Promise<T> {
    const result = await new Promise<unknown>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.close(), 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch {
        this.close();
      }
    });
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new Error('Unsupported Codex protocol response');
    return parsed.data;
  }

  /** 终止本功能拥有的进程、拒绝所有请求并广播断线；不影响 NAS 上其他 Codex 会话。 */
  close(): void {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    child?.stdin.destroy();
    child?.kill();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('Codex disconnected or timed out. Check its executable and login.'));
    }
    this.pending.clear();
    if (child) this.emit('disconnected');
  }
}
