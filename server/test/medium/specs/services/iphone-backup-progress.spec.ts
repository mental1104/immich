import { Queue } from 'bullmq';
import { Kysely } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { IphoneBackupCommandDto } from 'src/dtos/iphone-backup.dto.js';
import { ImmichWorker } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { IphoneBackupRepository } from 'src/repositories/iphone-backup.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { IphoneBackupService } from 'src/services/iphone-backup.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** 使用独立 PostgreSQL、Valkey 和合成文件贯通队列控制、持久化和真实内容指纹。 */
describe('iPhone fingerprint progress', () => {
  let db: Kysely<DB>;
  let redis: StartedTestContainer;
  let root: string;
  let libraryId: string;
  let repository: IphoneBackupRepository;
  let crypto: CryptoRepository;
  let config: ConfigRepository;
  let api: IphoneBackupService;
  let worker: IphoneBackupService | undefined;
  let queue: Queue;

  /** 只为本套测试建立数据库及缓存，不连接任何部署配置中的服务。 */
  beforeAll(async () => {
    db = await getKyselyDB();
    redis = await new GenericContainer('valkey/valkey:9').withExposedPorts(6379).start();
  });

  /** 释放独立服务，测试原片目录由各用例单独清理。 */
  afterAll(async () => {
    await db?.destroy();
    await redis?.stop();
  });

  /** 每例采用独立库、队列前缀和临时目录；默认仅运行 API，便于检验排队去重。 */
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'immich-fingerprint-progress-'));
    const { ctx } = newMediumService(LibraryService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const library = await ctx
      .get(LibraryRepository)
      .create({ ownerId: user.id, name: 'Synthetic progress test', importPaths: [root], exclusionPatterns: [] });
    libraryId = library.id;
    for (const name of ['first', 'second']) {
      const originalPath = join(root, `${name}.jpg`);
      await writeFile(originalPath, `synthetic-${name}`);
      await ctx.newAsset({
        ownerId: user.id,
        libraryId,
        originalPath,
        originalFileName: `${name}.jpg`,
        isExternal: true,
        checksum: createHash('sha1').update(originalPath).digest(),
      });
    }
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', libraryId);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', root);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_UPLOADS_ENABLED', 'false');
    config = new ConfigRepository();
    const options = {
      prefix: `fingerprint-test-${randomUUID()}`,
      connection: { host: '127.0.0.1', port: redis.getMappedPort(6379) },
    };
    const env = config.getEnv();
    vi.spyOn(config, 'getEnv').mockReturnValue({ ...env, bull: { ...env.bull, config: options } });
    crypto = new CryptoRepository();
    repository = new IphoneBackupRepository(db, crypto);
    api = new IphoneBackupService(ImmichWorker.Api, config, repository, LoggingRepository.create());
    await api.onBootstrap();
    queue = new Queue('fork-iphone-fingerprints', options);
  });

  /** 先停止消费者，再关闭连接和删除合成文件；不清空其他任何队列。 */
  afterEach(async () => {
    await worker?.onShutdown();
    worker = undefined;
    await api?.onShutdown();
    await queue?.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** @returns 启动本例唯一消费者；任务仍受 Redis 全局并发上限约束。 */
  async function startWorker() {
    worker = new IphoneBackupService(ImmichWorker.Microservices, config, repository, LoggingRepository.create());
    await worker.onBootstrap();
  }

  /** @param state 预期的队列最终状态。 @returns 状态满足后的 Promise，超时即用例失败。 */
  async function waitFor(state: string) {
    await expect
      .poll(
        async () => {
          const progress = await api.getProgress();
          return progress.state;
        },
        { timeout: 10_000 },
      )
      .toBe(state);
  }

  it('reports only the configured library and never starts work while reading status', async () => {
    expect(await api.getProgress()).toMatchObject({
      total: 2,
      ready: 0,
      pending: 2,
      state: 'idle',
      uploadsEnabled: false,
      batch: null,
    });
    expect(await queue.getJobCountByTypes()).toBe(0);
    await db.updateTable('asset').set({ isOffline: true }).where('libraryId', '=', libraryId).execute();
    expect(await repository.counts(libraryId)).toEqual({ total: 0, ready: 0, pending: 0 });
  });

  it('deduplicates concurrent starts and stops at the requested limit without changing originals or path checksums', async () => {
    const rows = await repository.candidates(libraryId, 2);
    const before = await db.selectFrom('asset').select(['id', 'checksum']).where('libraryId', '=', libraryId).execute();
    await Promise.all([api.command({ command: 'start', limit: 1 }), api.command({ command: 'start', limit: 1 })]);
    expect(await queue.getJobCountByTypes()).toBe(1);
    await startWorker();
    await waitFor('idle');
    expect(await api.getProgress()).toMatchObject({
      total: 2,
      ready: 1,
      pending: 1,
      batch: { completed: 1, reason: 'limit' },
    });
    const prepared = await db
      .selectFrom('asset')
      .select(['checksum', 'contentChecksum'])
      .where('id', '=', rows[0].id)
      .executeTakeFirstOrThrow();
    expect(prepared.checksum).toEqual(before.find(({ id }) => id === rows[0].id)!.checksum);
    expect(prepared.contentChecksum).toEqual(
      createHash('sha1')
        .update(await readFile(rows[0].originalPath))
        .digest(),
    );
    expect(await readFile(join(root, 'first.jpg'), 'utf8')).toBe('synthetic-first');
    expect(await readFile(join(root, 'second.jpg'), 'utf8')).toBe('synthetic-second');
  });

  it('preserves a paused queued batch across API restart and resumes it explicitly', async () => {
    await api.command({ command: 'start', limit: 2 });
    await api.command({ command: 'pause', limit: 2 });
    await api.onShutdown();
    api = new IphoneBackupService(ImmichWorker.Api, config, repository, LoggingRepository.create());
    await api.onBootstrap();
    await startWorker();
    expect(await api.getProgress()).toMatchObject({ state: 'paused', ready: 0 });
    await api.command({ command: 'resume', limit: 2 });
    await waitFor('completed');
    expect(await repository.counts(libraryId)).toEqual({ total: 2, ready: 2, pending: 0 });
  });

  it('pauses between files and resumes from the remaining database records', async () => {
    const prepare = repository.prepare.bind(repository);
    vi.spyOn(repository, 'prepare').mockImplementationOnce(async (id, row, size) => {
      const result = await prepare(id, row, size);
      await api.command({ command: 'pause', limit: 2 });
      return result;
    });
    await api.command({ command: 'start', limit: 2 });
    await startWorker();
    await waitFor('paused');
    expect(await api.getProgress()).toMatchObject({ ready: 1, pending: 1, batch: { completed: 1, reason: 'paused' } });
    await api.command({ command: 'resume', limit: 2 });
    await waitFor('completed');
    expect(await repository.counts(libraryId)).toEqual({ total: 2, ready: 2, pending: 0 });
  });

  it('retains a safe failure and retries explicitly without recording private error text', async () => {
    vi.spyOn(repository, 'prepare').mockRejectedValueOnce(new Error('/private/photo.jpg database detail'));
    await api.command({ command: 'start', limit: 2 });
    await startWorker();
    await waitFor('failed');
    expect(await api.getProgress()).toMatchObject({ ready: 0, pending: 2, batch: { errorCode: 'PREPARATION_FAILED' } });
    expect((await queue.getJob(libraryId))!.failedReason).toBe('PREPARATION_FAILED');
    await expect(api.command({ command: 'start', limit: 2 })).rejects.toThrow('Retry the failed');
    await api.command({ command: 'retry', limit: 2 });
    await waitFor('completed');
    expect(await api.getProgress()).toMatchObject({ ready: 2, pending: 0, uploadsEnabled: false });
  });

  it('stops at the byte budget rather than silently skipping the next file', async () => {
    const prepare = repository.prepare.bind(repository);
    vi.spyOn(repository, 'size').mockResolvedValue(5 * 1024 ** 3);
    vi.spyOn(repository, 'prepare').mockImplementation(async (id, row) => {
      const data = await readFile(row.originalPath);
      await prepare(id, row, data.length);
      return 5 * 1024 ** 3;
    });
    await api.command({ command: 'start', limit: 2 });
    await startWorker();
    await waitFor('idle');
    expect(await api.getProgress()).toMatchObject({ ready: 1, pending: 1, batch: { completed: 1, reason: 'budget' } });
    expect(repository.prepare).toHaveBeenCalledTimes(1);
  });

  it('refuses a single file larger than the batch budget without reading it', async () => {
    const hash = vi.spyOn(crypto, 'hashFile');
    vi.spyOn(repository, 'size').mockResolvedValue(9 * 1024 ** 3);
    await api.command({ command: 'start', limit: 2 });
    await startWorker();
    await waitFor('failed');
    expect(await api.getProgress()).toMatchObject({ ready: 0, batch: { errorCode: 'FILE_TOO_LARGE' } });
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects an asset changed during hashing without persisting a stale fingerprint', async () => {
    const [row] = await repository.candidates(libraryId, 1);
    const hash = crypto.hashFile.bind(crypto);
    vi.spyOn(crypto, 'hashFile').mockImplementationOnce(async (path) => {
      const result = await hash(path);
      await db.updateTable('asset').set({ isOffline: true }).where('id', '=', row.id).execute();
      return result;
    });
    await expect(repository.prepare(libraryId, row, await repository.size(row))).rejects.toThrow('ASSET_CHANGED');
    const asset = await db
      .selectFrom('asset')
      .select('contentChecksum')
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(asset.contentChecksum).toBeNull();
  });

  it('rejects a file changed during hashing without persisting a stale fingerprint', async () => {
    const [row] = await repository.candidates(libraryId, 1);
    const hash = crypto.hashFile.bind(crypto);
    vi.spyOn(crypto, 'hashFile').mockImplementationOnce(async (path) => {
      const result = await hash(path);
      await writeFile(path, 'changed synthetic content');
      return result;
    });
    await expect(repository.prepare(libraryId, row, await repository.size(row))).rejects.toThrow('FILE_CHANGED');
    const asset = await db
      .selectFrom('asset')
      .select('contentChecksum')
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(asset.contentChecksum).toBeNull();
  });

  it('validates bounded commands without accepting library routing from the request', () => {
    for (const limit of [0, 1001, 1.5]) {
      expect(IphoneBackupCommandDto.schema.safeParse({ command: 'start', limit }).success).toBe(false);
    }
    expect(IphoneBackupCommandDto.schema.parse({ command: 'start', libraryId: randomUUID() })).toEqual({
      command: 'start',
      limit: 1000,
    });
  });
});
