import { Queue, Worker } from 'bullmq';
import { Kysely } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { AssetFileType, ChecksumAlgorithm, ImmichWorker, JobName, JobStatus, SyncRequestType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { IphoneBackupImageRepository } from 'src/repositories/iphone-backup-image.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import {
  IPHONE_REFERENCE_QUEUE,
  IphoneBackupReconciliationService,
} from 'src/services/iphone-backup-reconciliation.service.js';
import { IphoneBackupReferenceService } from 'src/services/iphone-backup-reference.service.js';
import { LibraryService } from 'src/services/library.service.js';
import {
  createIphoneBackupRecovery,
  readIphoneBackupImage,
  restoreIphoneBackupImage,
} from 'src/utils/iphone-backup-image.js';
import { createIphoneBackupSnapshot } from 'src/utils/iphone-backup-snapshot.js';
import { createSyntheticIphoneHeic } from 'test/fixtures/iphone-heic.fixture.js';
import { SyncTestContext, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** @param path 本例完整副本路径。@returns 仅 ENOENT 表示文件不存在；权限及其他 I/O 错误使测试失败。 */
async function isAbsent(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

/** 独立 PostgreSQL、Valkey、ExifTool 和合成原片贯通自动关联、实际手机确认及清理边界。 */
describe('iPhone automatic backup reconciliation', () => {
  let db: Kysely<DB>;
  let redis: StartedTestContainer;
  let temporary: string;
  let root: string;
  let review: string;
  let userId: string;
  let libraryId: string;
  let config: ConfigRepository;
  let metadata: MetadataRepository;
  let logger: LoggingRepository;
  let jobs: JobRepository;
  let setup: ReturnType<typeof newMediumService<typeof LibraryService>>;
  let worker: IphoneBackupReconciliationService | undefined;
  let queue: Queue;
  let sync: SyncTestContext;
  let auth: ReturnType<typeof factory.auth>;

  /** 创建测试专用数据库和缓存，禁止使用部署环境中的数据库或 Redis。 */
  beforeAll(async () => {
    db = await getKyselyDB();
    redis = await new GenericContainer('valkey/valkey:9').withExposedPorts(6379).start();
  });

  /** 所有消费者停止后关闭测试服务。 */
  afterAll(async () => {
    await db?.destroy();
    await redis?.stop();
  });

  /** 每例使用独立归属、队列前缀、官方同步会话与文件根，真实恢复资料仅存在临时目录。 */
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'immich-reference-worker-'));
    root = join(temporary, 'Photos/Mobile');
    review = join(temporary, 'Photos/Review');
    await mkdir(root, { recursive: true });
    await mkdir(review, { recursive: true });
    const snapshotRoot = join(temporary, 'snapshots');
    await mkdir(snapshotRoot, { mode: 0o700 });
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT', snapshotRoot);
    setup = newMediumService(LibraryService, { database: db, real: [], mock: [LoggingRepository, JobRepository] });
    jobs = setup.ctx.getMock(JobRepository);
    const { user } = await setup.ctx.newUser();
    userId = user.id;
    const library = await setup.ctx.get(LibraryRepository).create({
      ownerId: userId,
      name: 'Synthetic reconciliation',
      importPaths: [join(temporary, 'Photos')],
      exclusionPatterns: [],
    });
    libraryId = library.id;
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', libraryId);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', root);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', review);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_AUTO_REFERENCES', 'true');
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_REFERENCE_SESSION_ID', '');
    sync = new SyncTestContext(db);
    const { session } = await sync.newSession({ userId });
    auth = factory.auth({ user: { id: userId }, session });
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_REFERENCE_SESSION_ID', session.id);
    config = new ConfigRepository();
    const env = config.getEnv();
    const options = {
      prefix: `reference-test-${randomUUID()}`,
      connection: { host: '127.0.0.1', port: redis.getMappedPort(6379) },
    };
    vi.spyOn(config, 'getEnv').mockReturnValue({ ...env, bull: { ...env.bull, config: options } });
    metadata = new MetadataRepository(LoggingRepository.create());
    logger = LoggingRepository.create();
    queue = new Queue(IPHONE_REFERENCE_QUEUE, options);
  });

  /** 先关闭正在读原片的消费者，再释放其 EXIF 进程、Redis 连接与当前测试文件。 */
  afterEach(async () => {
    await worker?.onShutdown();
    worker = undefined;
    await metadata.teardown();
    await queue.close();
    await rm(temporary, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** @returns 使用本例真实依赖启动一个消费者，启动巡检能发现事件发生前的历史暂存项。 */
  async function startWorker() {
    worker = new IphoneBackupReconciliationService(ImmichWorker.Microservices, db, config, metadata, logger, jobs);
    await worker.onBootstrap();
    return worker;
  }

  /** @returns 保存真实同步流中的 AssetV2 和 SyncCompleteV1 确认，不伪造游标或重置索引。 */
  async function acknowledge() {
    const events = await sync.syncStream(auth, [SyncRequestType.AssetsV2]);
    await sync.sut.setAcks(auth, { acks: events.map((event) => event.ack) });
  }

  /**
   * @param options different 为不同画面，days 为日期偏差，ready 为元数据是否就绪。
   * @returns 两份真实文件与资产；标签差异真实写入 NAS 合成原片，不模拟内容哈希。
   */
  async function pair(options: { different?: boolean; days?: number; ready?: boolean } = {}) {
    const suffix = randomUUID();
    const sourcePath = join(root, `${suffix}.jpg`),
      stagedPath = join(review, `${suffix}.jpg`);
    const phoneBytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#225599' } })
      .jpeg()
      .toBuffer();
    const sourceImage = options.different
      ? await sharp({ create: { width: 24, height: 16, channels: 3, background: '#993322' } })
          .jpeg()
          .toBuffer()
      : phoneBytes;
    await writeFile(stagedPath, phoneBytes);
    await writeFile(sourcePath, sourceImage);
    await metadata.writeTags(sourcePath, { Keywords: ['shared'], Subject: ['shared'] });
    const sourceBytes = await readFile(sourcePath);
    const { result: source } = await setup.ctx.newAsset({
      ownerId: userId,
      libraryId,
      originalPath: sourcePath,
      originalFileName: `${suffix}.jpg`,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${sourcePath}`).digest(),
      contentChecksum: createHash('sha1').update(sourceBytes).digest(),
    });
    const { result: version } = await setup.ctx.newAsset({
      ownerId: userId,
      libraryId,
      originalPath: stagedPath,
      originalFileName: `${suffix}.jpg`,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${stagedPath}`).digest(),
      contentChecksum: createHash('sha1').update(phoneBytes).digest(),
      fileCreatedAt: new Date(+new Date(source.fileCreatedAt) + (options.days ?? 0) * 86_400_000),
    });
    if (options.ready !== false) await ready(version.id);
    return { source, version, sourcePath, stagedPath, phoneBytes, sourceBytes };
  }

  /** @param id 本例资产。建立实际合成预览和元数据就绪状态，不替代原片的完整恢复校验。 */
  async function ready(id: string) {
    const path = join(temporary, `${id}-preview.jpg`);
    await writeFile(
      path,
      await sharp({ create: { width: 24, height: 16, channels: 3, background: '#225599' } })
        .jpeg()
        .toBuffer(),
    );
    await db
      .insertInto('asset_file')
      .values({ assetId: id, type: AssetFileType.Preview, path, isEdited: false })
      .onConflict((conflict) => conflict.columns(['assetId', 'type', 'isEdited']).doUpdateSet({ path }))
      .execute();
    await db
      .updateTable('asset')
      .set({ thumbhash: Buffer.from('synthetic-thumbhash') })
      .where('id', '=', id)
      .execute();
    await db
      .insertInto('asset_job_status')
      .values({ assetId: id, metadataExtractedAt: new Date() })
      .onConflict((conflict) => conflict.column('assetId').doUpdateSet({ metadataExtractedAt: new Date() }))
      .execute();
  }

  /** @param id 手机版资产。@returns 数据库确认关联建立，超时即失败，不根据日志猜测处理完成。 */
  async function waitPrepared(id: string) {
    await expect
      .poll(
        async () => {
          const version = await db
            .selectFrom('asset')
            .select('backupSourceId')
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
          return version.backupSourceId;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();
  }

  /** @returns 执行两次分页巡检，覆盖上一页为空时游标回到起点的情况。 */
  async function poll() {
    await worker!.reconcile();
    await worker!.reconcile();
  }

  /** @param states 要观察的队列状态。@returns 仅上传匹配任务，源索引和巡检独立验证。 */
  async function matchJobs(
    states: Parameters<Queue['getJobs']>[0] = ['waiting', 'active', 'completed', 'failed', 'prioritized'],
  ) {
    const matches = await queue.getJobs(states);
    return matches.filter((job) => job.name === 'match');
  }

  /** @param states 被计数的匹配任务状态。@returns 有限任务数，不包含独立源巡检。 */
  async function matchCount(states?: Parameters<Queue['getJobs']>[0]) {
    const matches = await matchJobs(states);
    return matches.length;
  }

  /** @returns 实际索引读取及匹配全部结束；后续重复巡检不应再次读取稳定版本。 */
  async function idle() {
    await expect
      .poll(async () => await queue.getJobCountByTypes('wait', 'active', 'prioritized'), { timeout: 15_000 })
      .toBe(0);
  }

  /** @param id 合成上传资产。记录可信接收事件，公开元数据不参与授权。 */
  async function trustUpload(id: string) {
    const asset = await db.selectFrom('asset').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const bytes = await readFile(asset.originalPath);
    await new IphoneBackupImageRepository(db).captureUpload({
      assetId: id,
      ownerId: userId,
      libraryId,
      originalPath: asset.originalPath,
      checksum: asset.contentChecksum!,
      recovery: createIphoneBackupRecovery(bytes, bytes),
      snapshot: {
        originalFileName: asset.originalFileName,
        fileCreatedAt: new Date(asset.fileCreatedAt).toISOString(),
        fileModifiedAt: new Date(asset.fileModifiedAt).toISOString(),
        type: asset.type,
        isFavorite: asset.isFavorite,
        visibility: asset.visibility,
        livePhotoVideoId: asset.livePhotoVideoId,
        duration: asset.duration,
      },
    });
  }

  /**
   * 用真实 BullMQ 生命周期保存旧能力的结论，不改 Redis 内部状态或假造任务完成字段。
   * @param action 需要升级复核的读取动作。@param id 对应的合成资产。@param failed 是否保留旧失败状态。
   * @param formatCapability 已保存的旧格式能力；省略表示第一版的原有持久任务。
   * @returns 相同资产版本及文件签名的原始任务，缺省能力字段表示升级前的持久数据。
   */
  async function legacyRead(
    action: 'match' | 'index' | 'refresh',
    id: string,
    failed = false,
    formatCapability?: number,
  ) {
    const asset = await db
      .selectFrom('asset')
      .select(['updateId', 'originalPath'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const stat = await lstat(asset.originalPath, { bigint: true });
    const signature = createHash('sha256')
      .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)
      .digest('hex');
    const data = {
      action,
      id,
      updateId: asset.updateId,
      ...(formatCapability !== undefined && { formatCapability }),
      ...(action === 'match' ? { hasEmbedding: false, generation: 0 } : { signature }),
    };
    const jobId = `${action}-${id}-${asset.updateId}-${action === 'match' ? 'time' : signature}`;
    const previousWorker = new Worker(
      IPHONE_REFERENCE_QUEUE,
      () => {
        if (failed) throw new Error('SYNTHETIC_PREVIOUS_FAILURE');
        return Promise.resolve({ status: 'unsupported' });
      },
      { ...config.getEnv().bull.config, concurrency: 1 },
    );
    try {
      const job = await queue.add(action, data, { jobId, attempts: 1, removeOnComplete: false, removeOnFail: false });
      await expect.poll(() => job.getState(), { timeout: 10_000 }).toBe(failed ? 'failed' : 'completed');
      return job;
    } finally {
      await previousWorker.close();
    }
  }

  /** @returns 已确认的真实引用与仍保留的精确自有底稿；模拟旧版仅删除 stage 后的持久状态。 */
  async function prepareLegacyCleanup() {
    const p = await pair();
    await trustUpload(p.version.id);
    const images = new IphoneBackupImageRepository(db);
    const own = await createIphoneBackupSnapshot({
      root: process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT!,
      sourcePath: p.stagedPath,
      sourceId: p.version.id,
      checksum: p.version.contentChecksum!.toString('hex'),
    });
    await images.recordSnapshot({
      sourceId: p.version.id,
      ownerId: userId,
      libraryId,
      sourcePath: p.stagedPath,
      checksum: p.version.contentChecksum!,
      path: own.path,
      signature: own.signature,
    });
    const references = new IphoneBackupReferenceService(db, metadata);
    const assessment = await references.assessAsset(p.version.id);
    expect(assessment?.plan).toBeDefined();
    await references.prepare(assessment!.plan!);
    await acknowledge();
    await unlink(p.stagedPath);
    const version = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    const data = { action: 'cleanup', id: version.id, updateId: version.updateId };
    return { ...p, own, images, data, jobId: `cleanup-${version.id}-${version.updateId}` };
  }

  /**
   * 用旧版真实消费者生成持久清理结果，不伪造 Redis 状态。
   * @param p 已确认的引用及任务身份。@param outcome 旧版成功结果或需要保留的失败。
   * @returns 已完成/失败的原始任务；旧版不认识 cleanupCapability 字段。
   */
  async function legacyCleanup(
    p: Awaited<ReturnType<typeof prepareLegacyCleanup>>,
    outcome: 'cleaned' | 'absent' | 'failed',
  ) {
    const previousWorker = new Worker(
      IPHONE_REFERENCE_QUEUE,
      () => {
        if (outcome === 'failed') throw new Error('SYNTHETIC_PREVIOUS_CLEANUP_FAILURE');
        return Promise.resolve({ status: outcome });
      },
      { ...config.getEnv().bull.config, concurrency: 1 },
    );
    try {
      const job = await queue.add('cleanup', p.data, {
        jobId: p.jobId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      });
      await expect.poll(() => job.getState(), { timeout: 10_000 }).toBe(outcome === 'failed' ? 'failed' : 'completed');
      return job;
    } finally {
      await previousWorker.close();
    }
  }

  /** 旧成功任务跨暂停和重启仍可补收精确遗留底稿，保持同一任务身份且只实际执行一次。 */
  it.each(['cleaned', 'absent'] as const)(
    'replays an old %s cleanup once for its exact remaining self snapshot',
    async (status) => {
      const p = await prepareLegacyCleanup();
      const previous = await legacyCleanup(p, status);
      const calls = vi.spyOn(IphoneBackupReferenceService.prototype, 'cleanup');
      await queue.pause();
      await startWorker();
      await worker!.onShutdown();
      worker = undefined;
      await startWorker();
      expect(await queue.isPaused()).toBe(true);
      expect(await readFile(p.own.path)).toEqual(p.phoneBytes);
      const paused = await queue.getJob(p.jobId);
      expect(paused?.data.cleanupCapability).toBeUndefined();
      expect(calls).not.toHaveBeenCalled();
      await queue.resume();
      await poll();
      await idle();
      const current = await queue.getJob(p.jobId);
      expect(current?.id).toBe(previous.id);
      expect(current?.data.cleanupCapability).toBe(1);
      expect(current?.returnvalue).toEqual({ status: 'absent' });
      expect(await isAbsent(p.own.path)).toBe(true);
      expect(await p.images.getSnapshot(p.version.id, p.version.contentChecksum!)).toBeUndefined();
      expect(calls).toHaveBeenCalledTimes(1);
      await worker!.onShutdown();
      worker = undefined;
      await startWorker();
      await poll();
      await idle();
      expect(calls).toHaveBeenCalledTimes(1);
      const completed = await queue.getJobs(['completed']);
      const cleanup = completed.filter((job) => job.name === 'cleanup');
      expect(cleanup).toHaveLength(1);
    },
  );

  /** 缺少精确键、来源不符或跨库均不能把旧成功状态变成新的文件清理权限。 */
  it.each(['no-own', 'other-checksum', 'wrong-origin', 'other-library'] as const)(
    'does not replay an old cleanup without exact redundant upload evidence: %s',
    async (failure) => {
      const p = await prepareLegacyCleanup();
      await legacyCleanup(p, 'cleaned');
      switch (failure) {
        case 'no-own': {
          await db.deleteFrom('fork_iphone_source_snapshot').where('sourceId', '=', p.version.id).execute();
          break;
        }
        case 'other-checksum': {
          await db
            .updateTable('fork_iphone_source_snapshot')
            .set({ checksum: createHash('sha1').update('unrelated-old-version').digest() })
            .where('sourceId', '=', p.version.id)
            .execute();
          break;
        }
        case 'wrong-origin': {
          await db
            .updateTable('fork_iphone_upload_origin')
            .set({ originalPath: join(review, 'unrelated.jpg') })
            .where('assetId', '=', p.version.id)
            .execute();
          break;
        }
        case 'other-library': {
          expect(await p.images.hasRedundantUploadSnapshot(p.version.id, randomUUID())).toBe(false);
          await db.deleteFrom('fork_iphone_upload_origin').where('assetId', '=', p.version.id).execute();
          break;
        }
      }
      const calls = vi.spyOn(IphoneBackupReferenceService.prototype, 'cleanup');
      await startWorker();
      await poll();
      await idle();
      expect(calls).not.toHaveBeenCalled();
      const current = await queue.getJob(p.jobId);
      expect(current?.data.cleanupCapability).toBeUndefined();
      expect(await readFile(p.own.path)).toEqual(p.phoneBytes);
    },
  );

  /** 升级不能自动重试旧失败；它的错误、次数和底稿跨重启保留。 */
  it('does not retry a failed legacy cleanup during the self snapshot capability upgrade', async () => {
    const p = await prepareLegacyCleanup();
    await legacyCleanup(p, 'failed');
    const calls = vi.spyOn(IphoneBackupReferenceService.prototype, 'cleanup');
    await startWorker();
    await poll();
    await idle();
    await worker!.onShutdown();
    worker = undefined;
    await startWorker();
    await poll();
    await idle();
    const current = await queue.getJob(p.jobId);
    expect(await current?.getState()).toBe('failed');
    expect(current?.failedReason).toBe('SYNTHETIC_PREVIOUS_CLEANUP_FAILURE');
    expect(current?.attemptsMade).toBe(1);
    expect(current?.data.cleanupCapability).toBeUndefined();
    expect(calls).not.toHaveBeenCalled();
    expect(await readFile(p.own.path)).toEqual(p.phoneBytes);
  });

  /** 已在队列中的旧任务继续原位执行，升级不改写数据、增加副本或丢失暂停状态。 */
  it('preserves a queued legacy cleanup across a paused restart and runs it once on resume', async () => {
    const p = await prepareLegacyCleanup();
    await queue.pause();
    await queue.add('cleanup', p.data, { jobId: p.jobId, removeOnComplete: false });
    const calls = vi.spyOn(IphoneBackupReferenceService.prototype, 'cleanup');
    await startWorker();
    await worker!.onShutdown();
    worker = undefined;
    await startWorker();
    expect(await queue.isPaused()).toBe(true);
    const queued = await queue.getJob(p.jobId);
    expect(await queued?.getState()).toBe('waiting');
    expect(queued?.data).toEqual(p.data);
    expect(calls).not.toHaveBeenCalled();
    await queue.resume();
    await poll();
    await idle();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await isAbsent(p.own.path)).toBe(true);
    const completed = await queue.getJobs(['completed']);
    const cleanup = completed.filter((job) => job.name === 'cleanup');
    expect(cleanup).toHaveLength(1);
  });

  /** 旧消费者执行中的任务不抢占；只有它真实完成且仍有遗留底稿才补查同一 ID。 */
  it('leaves an active legacy cleanup untouched before one completed upgrade replay', async () => {
    const p = await prepareLegacyCleanup();
    const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
    await queue.setGlobalConcurrency(1);
    const previousWorker = new Worker(
      IPHONE_REFERENCE_QUEUE,
      async () => {
        await barrier;
        return { status: 'cleaned' };
      },
      { ...config.getEnv().bull.config, concurrency: 1 },
    );
    const calls = vi.spyOn(IphoneBackupReferenceService.prototype, 'cleanup');
    try {
      await queue.add('cleanup', p.data, { jobId: p.jobId, removeOnComplete: false });
      await expect
        .poll(
          async () => {
            const job = await queue.getJob(p.jobId);
            return job?.getState();
          },
          { timeout: 10_000 },
        )
        .toBe('active');
      await startWorker();
      await poll();
      const active = await queue.getJob(p.jobId);
      expect(await active?.getState()).toBe('active');
      expect(active?.data).toEqual(p.data);
      expect(calls).not.toHaveBeenCalled();
      release();
      await previousWorker.close();
      await idle();
      await poll();
      await idle();
      expect(calls).toHaveBeenCalledTimes(1);
      const current = await queue.getJob(p.jobId);
      expect(current?.data.cleanupCapability).toBe(1);
      expect(await isAbsent(p.own.path)).toBe(true);
    } finally {
      release();
      await previousWorker.close();
    }
  }, 15_000);

  /** 所有读取动作都能复核旧“不支持”，同时保留任务身份和当前能力版本。 */
  it.each(['match', 'index', 'refresh'] as const)(
    'replays one completed legacy unsupported %s after format capability advances',
    async (action) => {
      const p = await pair({ ready: action === 'match' });
      const id = action === 'match' ? p.version.id : p.source.id;
      if (action === 'refresh') await trustUpload(id);
      const previous = await legacyRead(action, id);
      await startWorker();
      await idle();
      const current = await queue.getJob(previous.id!);
      expect(current?.id).toBe(previous.id);
      expect(current?.data.formatCapability).toBe(3);
      expect(current?.returnvalue).toEqual({
        status: action === 'match' ? 'prepared' : action === 'index' ? 'indexed' : 'refreshed',
      });
      if (action === 'match') await waitPrepared(id);
      else expect(await new IphoneBackupImageRepository(db).getFingerprint(id)).toBeDefined();
    },
  );

  /** MiPr 品牌支持补齐后，第二版持久“不支持”也必须按原任务身份复核，不能只覆盖缺省第一版任务。 */
  it.each(['match', 'index', 'refresh'] as const)(
    'replays a capability two MiPr unsupported %s once under capability three',
    async (action) => {
      const p = await pair({ ready: action === 'match' });
      const phone = createSyntheticIphoneHeic();
      const source = createSyntheticIphoneHeic('shared');
      for (const bytes of [phone, source]) {
        const brand = bytes.indexOf(Buffer.from('mif1'));
        expect(brand).toBeGreaterThan(0);
        bytes.write('MiPr', brand, 'ascii');
      }
      // 保留 JPEG 文件名以验证实际容器决定能力，升级重放不依赖重新命名资产或改变其 updateId。
      await writeFile(p.stagedPath, phone);
      await writeFile(p.sourcePath, source);
      await db
        .updateTable('asset')
        .set({ contentChecksum: createHash('sha1').update(phone).digest() })
        .where('id', '=', p.version.id)
        .execute();
      await db
        .updateTable('asset')
        .set({ contentChecksum: createHash('sha1').update(source).digest() })
        .where('id', '=', p.source.id)
        .execute();
      const id = action === 'match' ? p.version.id : p.source.id;
      if (action === 'refresh') await trustUpload(id);
      const previous = await legacyRead(action, id, false, 2);
      await startWorker();
      await idle();
      const current = await queue.getJob(previous.id!);
      expect(current?.id).toBe(previous.id);
      expect(current?.data.formatCapability).toBe(3);
      expect(current?.returnvalue).toEqual({
        status: action === 'match' ? 'prepared' : action === 'index' ? 'indexed' : 'refreshed',
      });
      if (action === 'match') await waitPrepared(id);
      else expect(await new IphoneBackupImageRepository(db).getFingerprint(id)).toMatchObject({ format: 'HEIC' });
      const finished = current?.finishedOn;
      await worker!.onShutdown();
      worker = undefined;
      await startWorker();
      await poll();
      await idle();
      const restarted = await queue.getJob(previous.id!);
      expect(restarted?.finishedOn).toBe(finished);
    },
  );

  /** 品牌修正不是失败重试授权；第二版失败仍原位保留，不能被第三版巡检重置。 */
  it.each(['match', 'index', 'refresh'] as const)(
    'preserves a failed capability two %s while capability three is available',
    async (action) => {
      const p = await pair({ ready: action === 'match' });
      const id = action === 'match' ? p.version.id : p.source.id;
      if (action === 'refresh') await trustUpload(id);
      const previous = await legacyRead(action, id, true, 2);
      await startWorker();
      await poll();
      await idle();
      const current = await queue.getJob(previous.id!);
      expect(await current?.getState()).toBe('failed');
      expect(current?.data.formatCapability).toBe(2);
      expect(current?.failedReason).toBe('SYNTHETIC_PREVIOUS_FAILURE');
      expect(current?.attemptsMade).toBe(1);
    },
  );

  /** 新增格式能力不自动重试任何旧失败，保留错误状态和旧版本数据供管理员明确处理。 */
  it.each(['match', 'index', 'refresh'] as const)(
    'preserves a failed legacy %s while format capability advances',
    async (action) => {
      const p = await pair({ ready: action === 'match' });
      const id = action === 'match' ? p.version.id : p.source.id;
      if (action === 'refresh') await trustUpload(id);
      const previous = await legacyRead(action, id, true);
      await startWorker();
      await idle();
      await poll();
      await idle();
      const current = await queue.getJob(previous.id!);
      expect(await current?.getState()).toBe('failed');
      expect(current?.data.formatCapability).toBeUndefined();
      expect(current?.failedReason).toBe('SYNTHETIC_PREVIOUS_FAILURE');
      expect(current?.attemptsMade).toBe(1);
    },
  );

  /** 第二版仍不支持的真实 TIFF 只复核一次，后续巡检不持续重读或循环入队。 */
  it('retains the current unsupported conclusion after one bounded format upgrade replay', async () => {
    const p = await pair({ ready: false });
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#225599' } })
      .tiff()
      .toBuffer();
    await writeFile(p.sourcePath, bytes);
    await db
      .updateTable('asset')
      .set({ contentChecksum: createHash('sha1').update(bytes).digest() })
      .where('id', '=', p.source.id)
      .execute();
    const previous = await legacyRead('index', p.source.id);
    const reads = vi.spyOn(metadata, 'readBackupTags');
    await startWorker();
    await idle();
    const current = await queue.getJob(previous.id!);
    expect(current?.data.formatCapability).toBe(3);
    expect(current?.returnvalue).toEqual({ status: 'unsupported' });
    expect(reads).toHaveBeenCalledTimes(1);
    await poll();
    await idle();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await readFile(p.sourcePath)).toEqual(bytes);
  });

  /** 本体索引不依赖日期或 ML；一页推进就重新检查旧未匹配任务，且复用同一持久任务。 */
  it('rechecks completed unmatched uploads after a bounded index batch without waiting for a full scan', async () => {
    const p = await pair({ days: 120 });
    await startWorker();
    await idle();
    const [before] = await matchJobs(['completed']);
    expect(before.returnvalue).toEqual({ status: 'unmatched' });
    expect(await new IphoneBackupImageRepository(db).getFingerprint(p.source.id)).toBeDefined();
    await poll();
    await waitPrepared(p.version.id);
    const [after] = await matchJobs(['completed']);
    expect(after.id).toBe(before.id);
    expect(await matchCount()).toBe(1);
    expect(after.data.generation).toBeGreaterThan(before.data.generation);
  });

  /** 常规目录只处理有不可伪造上传来源的副本；原有 NAS 资产永远没有清理资格。 */
  it('matches and cleans a trusted normal-root upload while preserving imported NAS originals', async () => {
    const p = await pair({ days: 120 });
    const normalPath = join(root, `incoming-${randomUUID()}.jpg`);
    await rename(p.stagedPath, normalPath);
    await db.updateTable('asset').set({ originalPath: normalPath }).where('id', '=', p.version.id).execute();
    await trustUpload(p.version.id);
    await startWorker();
    await idle();
    await poll();
    await waitPrepared(p.version.id);
    expect(await matchCount()).toBe(1);
    expect(await new IphoneBackupReferenceService(db, metadata).assessAsset(p.source.id)).toBeUndefined();
    await acknowledge();
    await poll();
    await expect.poll(() => isAbsent(normalPath), { timeout: 15_000 }).toBe(true);
    expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
    expect(await new IphoneBackupImageRepository(db).getUpload(p.source.id)).toBeUndefined();
  });

  /** 扩展名决定有界候选范围，实际指纹格式仍由严格读取后的文件头决定，不能把改名当成转码。 */
  it('admits HEIC and HEIF queue paths while classifying their verified actual container', async () => {
    const p = await pair({ days: 120 });
    const sourcePath = join(root, `synthetic-${randomUUID()}.HEIC`);
    const stagedPath = join(review, `synthetic-${randomUUID()}.heif`);
    // 合成 JPEG 刻意使用 HEIC/HEIF 名称，验证分类不会信任扩展名。
    await rename(p.sourcePath, sourcePath);
    await rename(p.stagedPath, stagedPath);
    await db.updateTable('asset').set({ originalPath: sourcePath }).where('id', '=', p.source.id).execute();
    await db.updateTable('asset').set({ originalPath: stagedPath }).where('id', '=', p.version.id).execute();
    await startWorker();
    await idle();
    await poll();
    await waitPrepared(p.version.id);
    const indexed = await new IphoneBackupImageRepository(db).getFingerprint(p.source.id);
    expect(indexed?.format).toBe('JPEG');
    expect(await readFile(sourcePath)).toEqual(p.sourceBytes);
    expect(await readFile(stagedPath)).toEqual(p.phoneBytes);
  });

  /** 真实可解码 HEIC 在标签及日期不同的情况下按编码关联，手机确认后仍可逐字节恢复原上传。 */
  it('indexes and cleans strict HEIC versions across changed metadata and a shifted capture date', async () => {
    const p = await pair({ days: 120 });
    const sourcePath = join(root, `synthetic-${randomUUID()}.HEIC`);
    const stagedPath = join(review, `synthetic-${randomUUID()}.heif`);
    const phoneBytes = createSyntheticIphoneHeic('phone-tag');
    const sourceBytes = createSyntheticIphoneHeic('nas-tag');
    await writeFile(sourcePath, sourceBytes);
    await writeFile(stagedPath, phoneBytes);
    await db
      .updateTable('asset')
      .set({ originalPath: sourcePath, contentChecksum: createHash('sha1').update(sourceBytes).digest() })
      .where('id', '=', p.source.id)
      .execute();
    await db
      .updateTable('asset')
      .set({ originalPath: stagedPath, contentChecksum: createHash('sha1').update(phoneBytes).digest() })
      .where('id', '=', p.version.id)
      .execute();
    await startWorker();
    await idle();
    await poll();
    await waitPrepared(p.version.id);
    const indexed = await new IphoneBackupImageRepository(db).getFingerprint(p.source.id);
    expect(indexed?.format).toBe('HEIC');
    const version = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    expect(version.backupChecksum).toEqual(createHash('sha1').update(phoneBytes).digest());
    expect(restoreIphoneBackupImage(sourceBytes, version.backupMetadata!)).toEqual(phoneBytes);
    await acknowledge();
    await poll();
    await expect.poll(() => isAbsent(stagedPath), { timeout: 15_000 }).toBe(true);
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
  });

  /** 同样带 ftyp 的 AVIF 不是已证明支持的 HEIC；严格读取失败后不得发布格式或安排共享清理。 */
  it('does not index an unsupported ftyp container merely because its filename is HEIC', async () => {
    const p = await pair();
    const sourcePath = join(root, `unsupported-${randomUUID()}.HEIC`);
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#225599' } })
      .avif()
      .toBuffer();
    expect(bytes.toString('ascii', 4, 8)).toBe('ftyp');
    await writeFile(sourcePath, bytes);
    await db
      .updateTable('asset')
      .set({ originalPath: sourcePath, contentChecksum: createHash('sha1').update(bytes).digest() })
      .where('id', '=', p.source.id)
      .execute();
    await startWorker();
    await idle();
    const completed = await queue.getJobs(['completed']);
    const indexed = completed.find((job) => job.name === 'index' && job.data.id === p.source.id);
    expect(indexed?.returnvalue).toEqual({ status: 'unsupported' });
    expect(await new IphoneBackupImageRepository(db).getFingerprint(p.source.id)).toBeUndefined();
    expect(await readFile(sourcePath)).toEqual(bytes);
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
  });

  /** 已引用来源的时间、GPS、标签二次写入只更新物理版本，恢复后的手机 SHA-1 保持不变。 */
  it('refreshes metadata-only NAS changes and republishes its persistent body index', async () => {
    const p = await pair();
    await startWorker();
    await waitPrepared(p.version.id);
    await idle();
    await poll();
    await idle();
    const images = new IphoneBackupImageRepository(db);
    const before = await images.getFingerprint(p.source.id);
    expect(before).toBeDefined();
    await metadata.writeTags(p.sourcePath, {
      Keywords: ['shared', 'later-tag'],
      DateTimeOriginal: '1970:01:01 00:00:00',
      GPSLatitude: 30,
      GPSLongitude: 104,
    });
    const changed = await readIphoneBackupImage(p.sourcePath, metadata);
    await poll();
    await idle();
    const source = await db.selectFrom('asset').selectAll().where('id', '=', p.source.id).executeTakeFirstOrThrow();
    const version = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    expect(source.contentChecksum?.toString('hex')).toBe(changed.checksum);
    expect(version.clientChecksum).toEqual(p.version.clientChecksum);
    expect(version.isOffline).toBe(false);
    expect(restoreIphoneBackupImage(await readFile(p.sourcePath), version.backupMetadata!)).toEqual(p.phoneBytes);
    const after = await images.getFingerprint(p.source.id);
    expect(after?.imageFingerprint).toBe(before?.imageFingerprint);
    expect(after?.fileChecksum.toString('hex')).toBe(changed.checksum);
    expect(after?.signature).toBe(changed.signature);
    const reads = vi.spyOn(metadata, 'readBackupTags');
    await poll();
    await idle();
    expect(reads).not.toHaveBeenCalled();
  });

  /** 上传后被管理软件改 EXIF 时先恢复手机原版本，官方元数据/缩略图准备后再做本体关联。 */
  it('queues official metadata for a recovered trusted upload before matching its new NAS metadata version', async () => {
    const p = await pair();
    await db.deleteFrom('asset').where('id', '=', p.version.id).execute();
    await trustUpload(p.source.id);
    await startWorker();
    await idle();
    await metadata.writeTags(p.sourcePath, {
      Keywords: ['shared', 'new-tag'],
      DateTimeOriginal: '1970:01:01 00:00:00',
    });
    await poll();
    await idle();
    const origin = await new IphoneBackupImageRepository(db).getUpload(p.source.id);
    expect(origin?.recoveredAssetId).toBeTruthy();
    const recovered = await db
      .selectFrom('asset')
      .selectAll()
      .where('id', '=', origin!.recoveredAssetId!)
      .executeTakeFirstOrThrow();
    expect(await readFile(recovered.originalPath)).toEqual(p.sourceBytes);
    expect(recovered.backupChecksum).toBeNull();
    expect(jobs.queue).toHaveBeenCalledWith({
      name: JobName.AssetExtractMetadata,
      data: { id: recovered.id, source: 'upload', assetType: recovered.type },
    });
    expect(await matchCount()).toBe(0);
    await ready(recovered.id);
    await worker!.onMetadataExtracted({ assetId: recovered.id, userId });
    await waitPrepared(recovered.id);
    const version = await db.selectFrom('asset').selectAll().where('id', '=', recovered.id).executeTakeFirstOrThrow();
    expect(version.backupSourceId).toBe(p.source.id);
    expect(version.backupChecksum).toEqual(origin!.checksum);
    expect(await readFile(p.sourcePath)).not.toEqual(p.sourceBytes);
  });

  /** 已上传的合成文件在重启补查中直接处理；确认前完整副本存在，确认后下载仍可逐字节恢复。 */
  it('reconciles an existing staged asset, keeps its identity, and cleans only after actual sync acknowledgement', async () => {
    const p = await pair();
    await startWorker();
    await waitPrepared(p.version.id);
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
    await poll();
    expect(await access(p.stagedPath)).toBeUndefined();
    const version = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    expect(version.id).toBe(p.version.id);
    expect(version.clientChecksum).toEqual(p.version.clientChecksum);
    expect(version.backupSourceId).toBe(p.source.id);
    await acknowledge();
    await poll();
    await expect.poll(() => isAbsent(p.stagedPath), { timeout: 15_000 }).toBe(true);
    expect(restoreIphoneBackupImage(await readFile(p.sourcePath), version.backupMetadata!)).toEqual(p.phoneBytes);
    expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
  });

  /** 配置关闭时即使存在可匹配文件也不启动后台任务。 */
  it('does not start work without the explicit opt-in', async () => {
    const p = await pair();
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_AUTO_REFERENCES', 'false');
    await startWorker();
    await poll();
    expect(await matchCount()).toBe(0);
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
  });

  /** 用可公开合成的 TIFF 模拟扩展名与实际格式不符；完整内容仍按真实 SHA-1 参与手机备份匹配。 */
  it('retains a differently encoded JPG-named upload as supported backup but unsupported deduplication', async () => {
    const p = await pair();
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#225599' } })
      .tiff()
      .toBuffer();
    const checksum = createHash('sha1').update(bytes).digest();
    await writeFile(p.stagedPath, bytes);
    await db.updateTable('asset').set({ contentChecksum: checksum }).where('id', '=', p.version.id).execute();
    await startWorker();
    await expect.poll(() => matchCount(['completed']), { timeout: 10_000 }).toBe(1);
    const [completed] = await matchJobs(['completed']);
    expect(completed.returnvalue).toEqual({ status: 'unsupported' });
    expect(await matchCount(['failed'])).toBe(0);
    expect(await readFile(p.stagedPath)).toEqual(bytes);
    const available = await setup.ctx.get(AssetRepository).getByChecksums(userId, [checksum]);
    expect(available.map((row) => row.id)).toContain(p.version.id);
  });

  /** 实际格式不符的 NAS 候选不能阻断后面的有效候选，真正的 I/O 错误仍由原保护处理。 */
  it('skips an unsupported source format while still verifying a later exact JPEG candidate', async () => {
    const p = await pair();
    const originalPath = join(root, 'synthetic-tiff-with-jpg-name.jpg');
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#225599' } })
      .tiff()
      .toBuffer();
    await writeFile(originalPath, bytes);
    await setup.ctx.newAsset({
      ownerId: userId,
      libraryId,
      originalPath,
      originalFileName: 'synthetic.jpg',
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${originalPath}`).digest(),
      contentChecksum: createHash('sha1').update(bytes).digest(),
      fileCreatedAt: p.source.fileCreatedAt,
      createdAt: new Date(+new Date(p.source.createdAt) - 86_400_000),
    });
    await startWorker();
    await waitPrepared(p.version.id);
    expect(await matchCount(['failed'])).toBe(0);
    const version = await db
      .selectFrom('asset')
      .select('backupSourceId')
      .where('id', '=', p.version.id)
      .executeTakeFirstOrThrow();
    expect(version.backupSourceId).toBe(p.source.id);
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
  });

  /** 元数据尚未准备时等待，正常完成事件能补齐任务。 */
  it('waits for metadata readiness and recovers when the metadata event arrives', async () => {
    const p = await pair({ ready: false });
    await startWorker();
    expect(await matchCount()).toBe(0);
    await ready(p.version.id);
    await worker!.onMetadataExtracted({ assetId: p.version.id, userId });
    await waitPrepared(p.version.id);
  });

  /** 上传的预览必须先生成；即使没有启用 ML，也能在缩略图完成事件后继续安全关联。 */
  it('waits for the phone preview before switching originals and does not require smart search', async () => {
    const p = await pair();
    await db.deleteFrom('asset_file').where('assetId', '=', p.version.id).execute();
    await db.updateTable('asset').set({ thumbhash: null }).where('id', '=', p.version.id).execute();
    await startWorker();
    await worker!.onMetadataExtracted({ assetId: p.version.id, userId });
    expect(await matchCount()).toBe(0);
    await ready(p.version.id);
    await worker!.onJobSuccess({
      job: { name: JobName.AssetGenerateThumbnails, data: { id: p.version.id } },
      response: JobStatus.Success,
    });
    await waitPrepared(p.version.id);
    const preview = await db
      .selectFrom('asset_file')
      .select('path')
      .where('assetId', '=', p.version.id)
      .where('type', '=', AssetFileType.Preview)
      .executeTakeFirstOrThrow();
    expect(await readFile(preview.path)).toEqual(p.phoneBytes);
  });

  /** 日期有偏差时先保留文件，已有视觉向量生成后再作严格校验。 */
  it('rechecks an unmatched date-shifted upload when its existing visual vector becomes available', async () => {
    const p = await pair({ days: 120 });
    await startWorker();
    await expect.poll(() => matchCount(['completed']), { timeout: 10_000 }).toBe(1);
    const [unmatched] = await matchJobs(['completed']);
    expect(unmatched.returnvalue).toEqual({ status: 'unmatched' });
    const embedding = JSON.stringify([1, ...Array.from({ length: 511 }, () => 0)]);
    await db
      .insertInto('smart_search')
      .values([
        { assetId: p.version.id, embedding },
        { assetId: p.source.id, embedding },
      ])
      .execute();
    await worker!.onJobSuccess({
      job: { name: JobName.SmartSearch, data: { id: p.version.id } },
      response: JobStatus.Success,
    });
    await waitPrepared(p.version.id);
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
  });

  /** 相同向量不能代替相同编码证明，已完成的未匹配结果也不反复读取。 */
  it('retains a different image despite an identical visual vector and does not repeatedly read it', async () => {
    const p = await pair({ different: true, days: 120 });
    const embedding = JSON.stringify([1, ...Array.from({ length: 511 }, () => 0)]);
    await db
      .insertInto('smart_search')
      .values([
        { assetId: p.version.id, embedding },
        { assetId: p.source.id, embedding },
      ])
      .execute();
    const reads = vi.spyOn(metadata, 'readBackupTags');
    await startWorker();
    await expect.poll(() => matchCount(['completed']), { timeout: 10_000 }).toBe(1);
    await idle();
    await poll();
    await idle();
    const count = reads.mock.calls.length;
    await poll();
    await worker!.onJobSuccess({
      job: { name: JobName.SmartSearch, data: { id: p.version.id } },
      response: JobStatus.Success,
    });
    await idle();
    expect(await matchCount()).toBe(1);
    expect(reads).toHaveBeenCalledTimes(count);
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
  });

  /** 重启保留管理员暂停状态和已有排队工作。 */
  it('preserves queue pause and queued work across a worker restart', async () => {
    const p = await pair();
    await queue.pause();
    await startWorker();
    await worker!.onMetadataExtracted({ assetId: p.version.id, userId });
    expect(await matchCount()).toBe(1);
    await worker!.onShutdown();
    worker = undefined;
    await startWorker();
    expect(await queue.isPaused()).toBe(true);
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
    await queue.resume();
    await waitPrepared(p.version.id);
  });

  /** 同时到达的完成事件也受全局生产者门闩和有限容量约束；背压只延后，不丢弃资产或失败记录。 */
  it('bounds queued work during concurrent upload events and retains overflow for later polling', async () => {
    const p = await pair();
    const template = await db
      .selectFrom('asset')
      .select([
        'ownerId',
        'libraryId',
        'type',
        'fileCreatedAt',
        'fileModifiedAt',
        'originalFileName',
        'contentChecksum',
        'checksumAlgorithm',
        'thumbhash',
        'localDateTime',
      ])
      .where('id', '=', p.version.id)
      .executeTakeFirstOrThrow();
    const synthetic = Array.from({ length: 401 }, (_, index) => {
      const id = randomUUID(),
        originalPath = join(review, `bounded-${index}.jpg`);
      return {
        ...template,
        isExternal: true,
        id,
        updateId: randomUUID(),
        originalPath,
        checksum: createHash('sha1').update(originalPath).digest(),
      };
    });
    await db.insertInto('asset').values(synthetic).execute();
    await db
      .insertInto('asset_job_status')
      .values(synthetic.map(({ id }) => ({ assetId: id, metadataExtractedAt: new Date() })))
      .execute();
    await db
      .insertInto('asset_file')
      .values(
        synthetic.map(({ id }) => ({
          assetId: id,
          type: AssetFileType.Preview,
          path: join(temporary, 'synthetic-unused-preview.jpg'),
          isEdited: false,
        })),
      )
      .execute();
    await queue.pause();
    await startWorker();
    await Promise.all(synthetic.map(({ id }) => worker!.onMetadataExtracted({ assetId: id, userId })));
    expect(await matchCount()).toBeLessThanOrEqual(400);
    // 重送仍未接收的事件，把有限窗口填满；同版本去重且窗口外项目继续保留在数据库。
    for (const { id } of synthetic) await worker!.onMetadataExtracted({ assetId: id, userId });
    expect(await matchCount()).toBe(400);
    expect(
      await db
        .selectFrom('asset')
        .select('id')
        .where(
          'id',
          'in',
          synthetic.map(({ id }) => id),
        )
        .execute(),
    ).toHaveLength(401);
  }, 15_000);

  /** 失败只保存固定错误码，完整副本保留并等待显式重试。 */
  it('retains a safe failure without private error text and succeeds only after explicit retry', async () => {
    const p = await pair();
    const reads = vi
      .spyOn(metadata, 'readBackupTags')
      .mockRejectedValueOnce(new Error('/private/photo.jpg secret metadata'));
    await startWorker();
    await expect.poll(() => matchCount(['failed']), { timeout: 10_000 }).toBe(1);
    const [failed] = await matchJobs(['failed']);
    expect(failed.failedReason).toBe('REFERENCE_RECONCILIATION_FAILED');
    await idle();
    const count = reads.mock.calls.length;
    await poll();
    expect(reads).toHaveBeenCalledTimes(count);
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
    await failed.retry('failed');
    await waitPrepared(p.version.id);
  });

  /** 乐观快照失效时跳过旧任务，补查新版本且保留客户端指纹。 */
  it('skips a stale queued snapshot and processes its replacement without resetting client matching', async () => {
    const p = await pair();
    await queue.pause();
    await startWorker();
    await worker!.onMetadataExtracted({ assetId: p.version.id, userId });
    await db.updateTable('asset').set({ isFavorite: true }).where('id', '=', p.version.id).execute();
    await queue.resume();
    await expect.poll(() => matchCount(['completed']), { timeout: 10_000 }).toBe(1);
    const [skipped] = await matchJobs(['completed']);
    expect(skipped.returnvalue).toEqual({ status: 'skipped' });
    await poll();
    await waitPrepared(p.version.id);
    const version = await db
      .selectFrom('asset')
      .select('clientChecksum')
      .where('id', '=', p.version.id)
      .executeTakeFirstOrThrow();
    expect(version.clientChecksum).toEqual(p.version.clientChecksum);
  });

  /** 旧确认及待重置会话不能授权删除文件。 */
  it('never uses an acknowledgement from before the reference update or a session awaiting reset', async () => {
    const p = await pair();
    await acknowledge();
    await startWorker();
    await waitPrepared(p.version.id);
    await poll();
    expect(await matchJobs(['waiting', 'active', 'completed', 'failed'])).toHaveLength(1);
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
    await acknowledge();
    await db.updateTable('session').set({ isPendingSyncReset: true }).where('id', '=', auth.session!.id).execute();
    await poll();
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
    await db.updateTable('session').set({ isPendingSyncReset: false }).where('id', '=', auth.session!.id).execute();
    await poll();
    await expect.poll(() => isAbsent(p.stagedPath), { timeout: 10_000 }).toBe(true);
  });

  /** NAS 原片之后变化也只能依赖已验证不可变底稿清理，手机原文件仍可逐字节还原。 */
  it('uses the verified immutable snapshot when the NAS source changes before cleanup', async () => {
    const p = await pair();
    await startWorker();
    await waitPrepared(p.version.id);
    await idle();
    await writeFile(p.sourcePath, Buffer.concat([p.sourceBytes, Buffer.from('changed')]));
    await acknowledge();
    await poll();
    // 源复核可能在第一次确认后推进引用版本；重新同步确认新的完整恢复状态后才允许清理。
    await idle();
    await acknowledge();
    await poll();
    await expect.poll(() => isAbsent(p.stagedPath), { timeout: 10_000 }).toBe(true);
    const version = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    const pinned = await new IphoneBackupImageRepository(db).getSnapshot(p.source.id, version.contentChecksum!);
    expect(pinned).toBeDefined();
    expect(restoreIphoneBackupImage(await readFile(pinned!.path), version.backupMetadata!)).toEqual(p.phoneBytes);
  });

  /** 未选定手机会话时仅建立引用，不启动清理。 */
  it('does not clean without an explicitly configured phone session', async () => {
    const p = await pair();
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_REFERENCE_SESSION_ID', '');
    await startWorker();
    await waitPrepared(p.version.id);
    await acknowledge();
    await poll();
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
    expect(await matchCount()).toBe(1);
  });

  /** 完成结果持久保留，重启不会再次检查同一版本的原片。 */
  it('preserves completed results across restart instead of rereading unchanged files', async () => {
    await pair({ different: true });
    const reads = vi.spyOn(metadata, 'readBackupTags');
    await startWorker();
    await expect.poll(() => matchCount(['completed']), { timeout: 10_000 }).toBe(1);
    await idle();
    await poll();
    await idle();
    await worker!.onShutdown();
    worker = undefined;
    const count = reads.mock.calls.length;
    await startWorker();
    await poll();
    expect(reads).toHaveBeenCalledTimes(count);
    expect(await matchCount()).toBe(1);
  });

  /** 逐资产接口严格限制目标，不能意外处理同批次其他文件。 */
  it('reconciles a single requested asset without accidentally processing another staged asset', async () => {
    const first = await pair(),
      second = await pair();
    const references = new IphoneBackupReferenceService(db, metadata);
    const assessment = await references.assessAsset(first.version.id);
    expect(assessment?.id).toBe(first.version.id);
    const secondVersion = await db
      .selectFrom('asset')
      .select('backupChecksum')
      .where('id', '=', second.version.id)
      .executeTakeFirstOrThrow();
    expect(secondVersion.backupChecksum).toBeNull();
    expect(await references.assessAsset(first.source.id)).toBeUndefined();
  });

  /** 避免把调查发现的回收站副本自动恢复，尊重已有删除状态。 */
  it('retains a full upload when the matching NAS asset is in trash', async () => {
    const p = await pair();
    const deletedAt = new Date();
    await db.updateTable('asset').set({ deletedAt }).where('id', '=', p.source.id).execute();
    await startWorker();
    await expect.poll(() => matchCount(['completed']), { timeout: 10_000 }).toBe(1);
    const source = await db
      .selectFrom('asset')
      .select('deletedAt')
      .where('id', '=', p.source.id)
      .executeTakeFirstOrThrow();
    expect(+new Date(source.deletedAt!)).toBe(+deletedAt);
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
  });

  /** NAS 路径和图像字节相同也不能跨用户或跨图库建立引用。 */
  it('does not reference an identical source owned by another user', async () => {
    const p = await pair();
    const { user } = await setup.ctx.newUser();
    const other = await setup.ctx
      .get(LibraryRepository)
      .create({ ownerId: user.id, name: 'Other synthetic library', importPaths: [root], exclusionPatterns: [] });
    await db
      .updateTable('asset')
      .set({ ownerId: user.id, libraryId: other.id })
      .where('id', '=', p.source.id)
      .execute();
    await startWorker();
    await expect.poll(() => matchCount(['completed']), { timeout: 10_000 }).toBe(1);
    const version = await db
      .selectFrom('asset')
      .select('backupSourceId')
      .where('id', '=', p.version.id)
      .executeTakeFirstOrThrow();
    expect(version.backupSourceId).toBeNull();
    expect(await readFile(p.stagedPath)).toEqual(p.phoneBytes);
  });

  /** 第一页即使全部失败，也要保留失败并推进后续页，不能永远阻塞新上传。 */
  it('advances beyond a failed first page without retrying or discarding its jobs', async () => {
    for (let index = 0; index < 101; index++) {
      const originalPath = join(review, `missing-synthetic-${index}.jpg`);
      const { result: asset } = await setup.ctx.newAsset({
        ownerId: userId,
        libraryId,
        originalPath,
        isExternal: true,
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
        checksum: createHash('sha1').update(originalPath).digest(),
        contentChecksum: createHash('sha1').update('synthetic').digest(),
      });
      await ready(asset.id);
    }
    await startWorker();
    await expect.poll(() => matchCount(['failed']), { timeout: 15_000 }).toBe(100);
    await worker!.reconcile();
    await expect.poll(() => matchCount(['failed']), { timeout: 15_000 }).toBe(101);
    await poll();
    expect(await matchCount()).toBe(101);
  });

  /** 两个独立消费者和重复巡检仍只能同时读取一份原片，不把进程内并发误当成全局限制。 */
  it('serializes actual original reads across two workers while deduplicating repeated events', async () => {
    const first = await pair(),
      second = await pair();
    const original = metadata.readBackupTags.bind(metadata);
    const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
    let active = 0,
      peak = 0;
    vi.spyOn(metadata, 'readBackupTags').mockImplementation(async (path) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await barrier;
        return await original(path);
      } finally {
        active--;
      }
    });
    const other = new IphoneBackupReconciliationService(
      ImmichWorker.Microservices,
      db,
      config,
      metadata,
      LoggingRepository.create(),
      jobs,
    );
    try {
      await startWorker();
      await expect.poll(() => active, { timeout: 10_000 }).toBe(1);
      await other.onBootstrap();
      await worker!.onMetadataExtracted({ assetId: first.version.id, userId });
      await other.onMetadataExtracted({ assetId: second.version.id, userId });
      // 保留一个短的真实调度窗口，让第二消费者有机会暴露错误的并发读取。
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(active).toBe(1);
      release();
      await waitPrepared(first.version.id);
      await waitPrepared(second.version.id);
      expect(peak).toBe(1);
      expect(await matchCount()).toBe(2);
    } finally {
      release();
      await other.onShutdown();
    }
  });
});
