import { getQueueToken } from '@nestjs/bullmq';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import z from 'zod';
import { DatabaseLock, QueueName } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/** 仅管理照片处理链路；离线转码、迁移和数据库维护不参与自动恢复。 */
export const PIPELINE_QUEUES = new Set([
  QueueName.Library,
  QueueName.MetadataExtraction,
  QueueName.VideoMetadataExtraction,
  QueueName.ThumbnailGeneration,
  QueueName.RawPairing,
  QueueName.Sidecar,
  QueueName.SmartSearch,
  QueueName.FaceDetection,
  QueueName.FacialRecognition,
  QueueName.DuplicateDetection,
  QueueName.Ocr,
  QueueName.Editor,
]);

const key = 'immich_fork:pipeline:pauses:v1';
const pauseSchema = z.object({
  mode: z.enum(['temporary', 'persistent']),
  pausedAt: z.number().int(),
  resumeAt: z.number().int().nullable(),
});
/** 独立于 BullMQ 内部键的暂停意图；时间为 UTC Unix 毫秒。 */
export type PipelinePause = z.infer<typeof pauseSchema>;

/** 持久化管理员暂停期限；数据库 advisory lock 串行化跨进程的暂停、续期及到期恢复。 */
@Injectable()
export class QueuePauseRepository {
  readonly enabled = process.env.IMMICH_FORK_PIPELINE_AUTO_RESUME === 'true';
  readonly durationMs = z.coerce
    .number()
    .int()
    .min(1000)
    .max(86_400_000)
    .parse(process.env.IMMICH_FORK_PIPELINE_PAUSE_MS ?? 900_000);
  private readonly intervalMs = z.coerce
    .number()
    .int()
    .min(250)
    .max(60_000)
    .parse(process.env.IMMICH_FORK_PIPELINE_CHECK_MS ?? 10_000);
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;

  /** @param moduleRef 原生队列提供者。 @param database 锁的持有者。 @param logger 运维诊断输出。 */
  constructor(
    private moduleRef: ModuleRef,
    private database: DatabaseRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(QueuePauseRepository.name);
  }

  /** @param name 队列名称。 @returns Nest 托管的原生队列，不创建额外连接。 */
  private queue(name: QueueName): Queue {
    return this.moduleRef.get(getQueueToken(name), { strict: false });
  }

  /** @returns 共用连接上的 Fork 状态哈希访问器；不读写 BullMQ 内部状态。 */
  private async client(): Promise<Pick<Redis, 'hget' | 'hset' | 'hdel'>> {
    // BullMQ 5 的连接位于 client，6 移至 getBackend；同一补丁用于现有稳定版及开发基线。
    const queue = this.queue(QueueName.BackgroundTask) as unknown as {
      getBackend?: () => { client: Promise<Redis> };
      client: Promise<Redis>;
    };
    return queue.getBackend ? queue.getBackend().client : queue.client;
  }

  /** @param name 队列名称。 @returns 已持久化的暂停意图，未记录时为空；损坏记录抛错，避免误恢复维护。 */
  private async read(name: QueueName): Promise<PipelinePause | null> {
    const client = await this.client();
    const value = await client.hget(key, name);
    return value ? pauseSchema.parse(JSON.parse(value)) : null;
  }

  /**
   * @param name 要暂停的队列。
   * @param mode 管理员普通暂停传 temporary；内部初始化及明确维护传 persistent。
   * @returns 持久化暂停后完成；关闭功能或不属于照片链路时保留原有无限期语义。
   */
  async pause(name: QueueName, mode: PipelinePause['mode'] = 'persistent'): Promise<void> {
    await this.database.withLock(DatabaseLock.ForkPipelinePause, async () => {
      const temporary = this.enabled && PIPELINE_QUEUES.has(name) && mode === 'temporary';
      const now = Date.now();
      // 先记录意图再暂停。中途重启至多留下可清理的意图，不会留下无期限的临时暂停。
      const client = await this.client();
      await client.hset(
        key,
        name,
        JSON.stringify({
          mode: temporary ? 'temporary' : 'persistent',
          pausedAt: now,
          resumeAt: temporary ? now + this.durationMs : null,
        } satisfies PipelinePause),
      );
      await this.queue(name).pause();
    });
  }

  /** @param name 要恢复的队列。 @returns 先恢复原生队列再清理意图；失败时保留期限供下轮重试。 */
  async resume(name: QueueName): Promise<void> {
    await this.database.withLock(DatabaseLock.ForkPipelinePause, async () => {
      await this.queue(name).resume();
      const client = await this.client();
      await client.hdel(key, name);
    });
  }

  /** @returns 管理员可见的暂停期限和原生状态，不触发扫描或补跑。 */
  async getPolicy() {
    return {
      enabled: this.enabled,
      durationMs: this.durationMs,
      queues: await Promise.all(
        [...PIPELINE_QUEUES].map(async (name) => ({
          name,
          isPaused: await this.queue(name).isPaused(),
          pause: await this.read(name),
        })),
      ),
    };
  }

  /** @param name 照片链路队列。 @param mode 临时暂停、明确维护或恢复。 @returns 更新后的策略。 */
  async command(name: QueueName, mode: PipelinePause['mode'] | 'resume') {
    if (!PIPELINE_QUEUES.has(name)) {
      throw new BadRequestException('Queue is not part of the photo pipeline');
    }
    await (mode === 'resume' ? this.resume(name) : this.pause(name, mode));
    return this.getPolicy();
  }

  /** API 进程启动时立即核对持久化期限；定时失败仅记录日志，后续周期继续恢复。 */
  start(): void {
    if (!this.enabled || this.timer) {
      return;
    }
    /** 每个进程至多一个核对任务；跨进程写入仍由数据库锁保护。 */
    const check = () =>
      void this.reconcile().catch((error) => this.logger.error(`Pipeline pause check failed: ${error}`));
    this.timer = setInterval(check, this.intervalMs);
    check();
  }

  /** 停止本进程计时器，保留 Redis 中的期限供重启后继续。 */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** @returns 已到期的临时暂停恢复后完成；未登记的历史暂停先领取完整期限，维护暂停保持不动。 */
  async reconcile(): Promise<void> {
    if (!this.enabled || this.checking) {
      return;
    }
    this.checking = true;
    try {
      await this.database.withLock(DatabaseLock.ForkPipelinePause, async () => {
        const client = await this.client();
        for (const name of PIPELINE_QUEUES) {
          const queue = this.queue(name);
          const pause = await this.read(name);
          if (!(await queue.isPaused())) {
            await client.hdel(key, name);
            continue;
          }
          // 旧版本遗留暂停没有期限；启用后给一次完整宽限期，避免永久积压。
          if (!pause) {
            const now = Date.now();
            await client.hset(
              key,
              name,
              JSON.stringify({
                mode: 'temporary',
                pausedAt: now,
                resumeAt: now + this.durationMs,
              } satisfies PipelinePause),
            );
          } else if (pause.mode === 'temporary' && pause.resumeAt !== null && pause.resumeAt <= Date.now()) {
            await queue.resume();
            await client.hdel(key, name);
            this.logger.log(`Automatically resumed photo pipeline queue: ${name}`);
          }
        }
      });
    } finally {
      this.checking = false;
    }
  }
}
