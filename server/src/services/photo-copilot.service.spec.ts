import { access as fileAccess, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { firstValueFrom } from 'rxjs';
import sharp from 'sharp';
import z from 'zod';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetType, RawExtractedFormat } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { PhotoCopilotRepository } from 'src/repositories/photo-copilot.repository.js';
import { AssetService } from 'src/services/asset.service.js';
import { PhotoCopilotService } from 'src/services/photo-copilot.service.js';
import { PhotoCodexClient } from 'src/utils/photo-copilot.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { getForAsset } from 'test/mappers.js';
import { newAccessRepositoryMock } from 'test/repositories/access.repository.mock.js';
import { newMediaRepositoryMock } from 'test/repositories/media.repository.mock.js';
import { automock, mockBaseService } from 'test/utils.js';

/** 真实文件 + 数据库/Codex 替身；验证会话不串图、文件只读、取消及内嵌预览清理。 */
describe(PhotoCopilotService.name, () => {
  const auth = AuthFactory.create();
  const asset = AssetFactory.create({
    ownerId: auth.user.id,
    type: AssetType.Image,
    originalFileName: 'synthetic.png',
  });
  const assets = mockBaseService(AssetService);
  const records = automock(AssetRepository, { strict: false });
  const albums = automock(AlbumRepository, { strict: false });
  const media = newMediaRepositoryMock();
  const access = newAccessRepositoryMock();
  const history = automock(PhotoCopilotRepository, { strict: false });
  const saved = new Map<
    string,
    NonNullable<Awaited<ReturnType<PhotoCopilotRepository['get']>>> & {
      ownerId: string;
      assetId: string;
    }
  >();
  let service: PhotoCopilotService;
  let home: string;
  let client: PhotoCodexClient;
  let threadIndex = 0;

  /** @param method RPC 方法。@param _params 请求正文。@param schema 结果边界。@returns 经过 Schema 校验的替身响应；保留接收者以注入官方通知。 */
  function respond<T>(this: PhotoCodexClient, method: string, _params: object, schema: z.ZodType<T>): Promise<T> {
    // 测试必须向本轮服务创建的 EventEmitter 投递通知，不能另造一个未接线的客户端。
    // eslint-disable-next-line unicorn/no-this-assignment, @typescript-eslint/no-this-alias
    client = this;
    return Promise.resolve(
      schema.parse(
        method === 'thread/start' ? { thread: { id: `thread-${++threadIndex}` } } : { turn: { id: 'turn-test' } },
      ),
    );
  }

  /** @returns 共享同一历史存储的新实例，模拟服务重启。 */
  function startService() {
    return new PhotoCopilotService(
      assets,
      records,
      albums,
      access as unknown as AccessRepository,
      media as unknown as ConstructorParameters<typeof PhotoCopilotService>[4],
      history,
    );
  }

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'photo-copilot-unit-'));
    await mkdir(path.join(home, 'workspace'));
    await writeFile(
      path.join(home, 'synthetic.png'),
      await sharp({ create: { width: 10, height: 10, channels: 3, background: 'green' } })
        .png()
        .toBuffer(),
    );
    vi.stubEnv('IMMICH_PHOTO_COPILOT_ENABLED', 'true');
    vi.stubEnv('IMMICH_PHOTO_COPILOT_HOME', home);
    vi.spyOn(PhotoCodexClient.prototype, 'connect').mockResolvedValue();
    vi.spyOn(PhotoCodexClient.prototype, 'request').mockImplementation(respond);
    assets.get.mockResolvedValue(mapAsset(getForAsset(asset)));
    records.getById.mockResolvedValue({ ...getForAsset(asset), originalPath: path.join(home, 'synthetic.png') });
    albums.getByAssetId.mockResolvedValue([]);
    access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    saved.clear();
    history.create.mockImplementation((id, ownerId, assetId) => {
      saved.set(id, { ownerId, assetId, status: 'idle', messages: [] });
      return Promise.resolve();
    });
    history.get.mockImplementation((id, ownerId, assetId) => {
      const row = saved.get(id);
      return Promise.resolve(row?.ownerId === ownerId && row.assetId === assetId ? structuredClone(row) : undefined);
    });
    history.begin.mockImplementation((id, position, message) => {
      const row = saved.get(id)!;
      if (row.messages.length !== position) return Promise.resolve(false);
      row.status = 'starting';
      row.messages.push(structuredClone(message));
      return Promise.resolve(true);
    });
    history.finish.mockImplementation((id, position, messages, status) => {
      const row = saved.get(id)!;
      if (row.status !== 'starting' || row.messages.length !== position) return Promise.resolve(false);
      row.status = status;
      row.messages.push(...structuredClone(messages));
      return Promise.resolve(true);
    });
    service = startService();
  });
  afterEach(async () => {
    service.onModuleDestroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  /** 元数据只从服务端读取，响应不能携带原片目录。 */
  it('loads structured server context and reopens the same session', async () => {
    const state = await service.open(auth, asset.id);
    expect(state.context.assetId).toBe(asset.id);
    expect(JSON.stringify(state)).not.toContain(asset.originalPath);
    expect(await service.open(auth, asset.id, state.id)).toEqual(state);
    expect(await firstValueFrom(await service.events(auth, asset.id, state.id))).toEqual({ data: state });
  });

  /** 复用会话前必须匹配用户、照片及当下权限。 */
  it('rejects another user, another asset and revoked asset access', async () => {
    const state = await service.open(auth, asset.id);
    await expect(service.open(AuthFactory.create(), asset.id, state.id)).rejects.toThrow('unavailable');
    await expect(service.open(auth, '00000000-0000-4000-8000-000000000000', state.id)).rejects.toThrow('unavailable');
    access.asset.checkOwnerAccess.mockResolvedValue(new Set());
    await expect(service.send(auth, asset.id, state.id, 'hello')).rejects.toThrow();
  });

  /** 真正原图作为 localImage 发送，流增量更新同一线程，多轮沿用会话。 */
  it('sends an original image, streams text and supports another turn', async () => {
    const original = await readFile(path.join(home, 'synthetic.png'));
    const state = await service.open(auth, asset.id);
    await service.send(auth, asset.id, state.id, 'describe it');
    expect(state.image).toBe('original');
    expect(client.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        input: expect.arrayContaining([{ type: 'localImage', path: path.join(home, 'synthetic.png') }]),
        additionalContext: expect.objectContaining({ immich_photo: expect.objectContaining({ kind: 'untrusted' }) }),
      }),
      expect.anything(),
    );
    const threadId = `thread-${threadIndex}`;
    client.emit('notification', {
      method: 'item/agentMessage/delta',
      params: { threadId, itemId: 'answer1', delta: 'green ' },
    });
    client.emit('notification', {
      method: 'item/agentMessage/delta',
      params: { threadId, itemId: 'answer1', delta: 'square' },
    });
    expect(state.messages.at(-1)?.text).toBe('green square');
    client.emit('notification', {
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-test', status: 'completed' } },
    });
    await vi.waitFor(() => expect(state.busy).toBe(false));
    await service.send(auth, asset.id, state.id, 'what color was it?');
    expect(state.messages.filter((item) => item.role === 'user')).toHaveLength(2);
    expect(await readFile(path.join(home, 'synthetic.png'))).toEqual(original);
  });

  /** 停止先进入 stopping，只有官方终态才能释放 busy。 */
  it('interrupts only the active turn and waits for its terminal event', async () => {
    const state = await service.open(auth, asset.id);
    await service.send(auth, asset.id, state.id, 'long answer');
    await expect(service.send(auth, asset.id, state.id, 'double submit')).rejects.toThrow('already running');
    await service.stop(auth, asset.id, state.id);
    expect(state.status).toBe('stopping');
    expect(state.busy).toBe(true);
    client.emit('notification', {
      method: 'item/agentMessage/delta',
      params: { threadId: `thread-${threadIndex}`, itemId: 'partial', delta: 'The start of a reply' },
    });
    client.emit('notification', {
      method: 'turn/completed',
      params: { threadId: `thread-${threadIndex}`, turn: { id: 'turn-test', status: 'interrupted' } },
    });
    await vi.waitFor(() => expect(state.status).toBe('interrupted'));
    expect(state.busy).toBe(false);
    expect(saved.get(state.id)?.messages.at(-1)?.text).toBe('The start of a reply');
  });

  /** 不同线程的流不应污染当前照片。 */
  it('ignores notifications from other photos and marks process loss', async () => {
    const state = await service.open(auth, asset.id);
    await service.send(auth, asset.id, state.id, 'test');
    client.emit('notification', {
      method: 'item/agentMessage/delta',
      params: { threadId: 'another-photo-thread', itemId: 'other', delta: 'wrong image' },
    });
    expect(state.messages).toHaveLength(1);
    client.emit('disconnected');
    await vi.waitFor(() => expect(state.status).toBe('failed'));
    expect(state.error).toContain('disconnected');
  });

  /** 只把当前工作台轮次的公开摘要交给进度接口，终态 JSON 仍独立校验。 */
  it('forwards public analysis summary deltas without forwarding raw reasoning', async () => {
    const onSummary = vi.fn();
    const result = service.analyzePhoto('analyze', [], {}, z.object({ verdict: z.string() }), onSummary);
    await vi.waitFor(() => {
      expect(client?.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({ summary: 'concise' }),
        expect.anything(),
      );
    });
    const threadId = `thread-${threadIndex}`;
    const turnId = 'turn-test';
    const params = { threadId, turnId, itemId: 'reasoning', summaryIndex: 0 };
    client.emit('notification', { method: 'item/reasoning/summaryTextDelta', params: { ...params, delta: 'Crop' } });
    client.emit('notification', { method: 'item/reasoning/textDelta', params: { ...params, delta: 'hidden' } });
    client.emit('notification', {
      method: 'item/reasoning/summaryTextDelta',
      params: { ...params, turnId: 'another-turn', delta: 'unrelated' },
    });
    client.emit('notification', {
      method: 'item/reasoning/summaryTextDelta',
      params: { ...params, summaryIndex: 1, delta: 'Light' },
    });
    expect(onSummary.mock.calls).toEqual([['Crop'], ['\n\nLight']]);
    client.emit('notification', {
      method: 'item/completed',
      params: { threadId, turnId, item: { id: 'answer', type: 'agentMessage', text: '{"verdict":"ok"}' } },
    });
    client.emit('notification', {
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed' } },
    });
    await expect(result).resolves.toEqual({ verdict: 'ok' });
  });

  /** NEF 只提取内嵌图；临时图在完成后清理，原片不变。 */
  it('extracts a NEF embedded preview and cleans it after completion', async () => {
    const bytes = await readFile(path.join(home, 'synthetic.png'));
    assets.get.mockResolvedValue({ ...mapAsset(getForAsset(asset)), originalFileName: 'synthetic.NEF' });
    records.getById.mockResolvedValue({
      ...getForAsset(asset),
      originalFileName: 'synthetic.NEF',
      originalPath: path.join(home, 'synthetic.png'),
    });
    media.extract.mockResolvedValue({ buffer: bytes, format: RawExtractedFormat.Jpeg });
    const state = await service.open(auth, asset.id);
    await service.send(auth, asset.id, state.id, 'describe raw');
    expect(state.image).toBe('embedded-preview');
    const call = vi.mocked(client.request).mock.calls.findLast((args) => args[0] === 'turn/start');
    expect(call?.[1]).toEqual(
      expect.objectContaining({ input: expect.arrayContaining([expect.objectContaining({ type: 'localImage' })]) }),
    );
    const inputs = z
      .object({ input: z.array(z.object({ type: z.string(), path: z.string().optional() })) })
      .parse(call?.[1]);
    const temporary = inputs.input.find((input) => input.type === 'localImage')?.path;
    expect(temporary).toBeDefined();
    await expect(fileAccess(temporary!)).resolves.toBeUndefined();
    client.emit('notification', {
      method: 'turn/completed',
      params: { threadId: `thread-${threadIndex}`, turn: { id: 'turn-test', status: 'completed' } },
    });
    await vi.waitFor(async () => {
      await expect(fileAccess(temporary!)).rejects.toThrow();
    });
    expect(await readFile(path.join(home, 'synthetic.png'))).toEqual(bytes);
  });

  /** 未启用时不应启动 Codex。 */
  it('reports a disabled backend without spawning Codex', async () => {
    vi.stubEnv('IMMICH_PHOTO_COPILOT_ENABLED', 'false');
    await expect(service.open(auth, asset.id)).rejects.toThrow('disabled');
    expect(PhotoCodexClient.prototype.connect).not.toHaveBeenCalled();
  });

  /** 错填已有 Codex HOME 时不能覆盖其工具/模型配置。 */
  it('preserves an existing unrelated Codex configuration', async () => {
    const previous = 'model = "existing-model"\n';
    await writeFile(path.join(home, 'config.toml'), previous);
    const state = await service.open(auth, asset.id);
    const reply = await service.send(auth, asset.id, state.id, 'Describe the photo');
    expect(reply.error).toContain('dedicated directory');
    expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toBe(previous);
    expect(PhotoCodexClient.prototype.connect).not.toHaveBeenCalled();
  });

  /** 重启后直接读原会话，追问时才创建新模型线程并传入历史文字。 */
  it('restores saved messages and gives a new Codex thread the previous conversation', async () => {
    const state = await service.open(auth, asset.id);
    await service.send(auth, asset.id, state.id, 'Remember the word cedar');
    const originalThread = `thread-${threadIndex}`;
    client.emit('notification', {
      method: 'item/completed',
      params: { threadId: originalThread, item: { id: 'reply', type: 'agentMessage', text: 'I will remember it.' } },
    });
    client.emit('notification', {
      method: 'turn/completed',
      params: { threadId: originalThread, turn: { id: 'turn-test', status: 'completed' } },
    });
    await vi.waitFor(() => expect(state.status).toBe('completed'));
    service.onModuleDestroy();
    service = startService();
    const restored = await service.open(auth, asset.id, state.id);
    expect(restored.messages).toEqual(state.messages);
    expect(restored.status).toBe('completed');
    expect(`thread-${threadIndex}`).toBe(originalThread);
    await service.send(auth, asset.id, state.id, 'What was the word?');
    expect(client.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        threadId: `thread-${threadIndex}`,
        additionalContext: expect.objectContaining({
          immich_photo_chat: {
            kind: 'untrusted',
            name: 'immich_photo_chat_history_v1',
            value: JSON.stringify([
              { role: 'user', text: 'Remember the word cedar' },
              { role: 'assistant', text: 'I will remember it.' },
            ]),
          },
        }),
      }),
      expect.anything(),
    );
    expect(`thread-${threadIndex}`).not.toBe(originalThread);
  });

  /** 重启后仍能看到已保存的问题，本轮状态变为中断。 */
  it('restores an unfinished turn as interrupted with the saved question', async () => {
    const state = await service.open(auth, asset.id);
    await service.send(auth, asset.id, state.id, 'Question before restart');
    service.onModuleDestroy();
    service = startService();
    const restored = await service.open(auth, asset.id, state.id);
    expect(restored).toMatchObject({ status: 'interrupted', busy: false });
    expect(restored.messages).toEqual([{ id: state.messages[0].id, role: 'user', text: 'Question before restart' }]);
  });

  /** 保存失败的请求不应调用模型，错误也不回显数据库详情。 */
  it('rejects an unsaved question before starting Codex', async () => {
    history.begin.mockRejectedValueOnce(new Error('Sensitive database error'));
    const state = await service.open(auth, asset.id);
    await expect(service.send(auth, asset.id, state.id, 'Private question')).rejects.toThrow('Could not save');
    expect(state).toMatchObject({ busy: false, status: 'idle', messages: [] });
    expect(PhotoCodexClient.prototype.connect).not.toHaveBeenCalled();
  });
});
