import { Inject, Injectable } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { IWorker } from 'src/constants.js';
import { OnEvent } from 'src/decorators.js';
import { AssetFileType, DatabaseLock, ImmichWorker, JobName, JobStatus, SyncEntityType } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { IphoneBackupImageRepository } from 'src/repositories/iphone-backup-image.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { IphoneBackupReferenceService } from 'src/services/iphone-backup-reference.service.js';
import { IphoneBackupSourceService } from 'src/services/iphone-backup-source.service.js';
import { UnsupportedIphoneBackupImageError, readIphoneBackupImage } from 'src/utils/iphone-backup-image.js';
import { getIphoneBackupConfig, isWithinDirectory } from 'src/utils/iphone-backup.js';
import { fromAck } from 'src/utils/sync.js';

export const IPHONE_REFERENCE_QUEUE = 'fork-iphone-references';
const PAGE_SIZE = 100;
const POLL_INTERVAL_MS = 30_000;
const MAX_PENDING = 400;
/** 第三版接受标准 MiPr 兼容品牌；旧的不支持结论仅在能力升级时有界复核一次。 */
const FORMAT_CAPABILITY = 3;
/** 首次回收可信上传的冗余自有底稿；旧成功任务仅在精确底稿仍有记录时补查一次。 */
const CLEANUP_CAPABILITY = 1;

/** 资产版本及 stat 签名限定实际读取；索引世代只复用已完成未命中的匹配任务。 */
type ReferenceJob = (
  | { action: 'match'; id: string; updateId: string; hasEmbedding: boolean; generation: number }
  | { action: 'cleanup'; id: string; updateId: string; cleanupCapability?: number }
  | { action: 'index' | 'refresh'; id: string; updateId: string; signature: string }
) & { formatCapability?: number };

/** 队列只保存安全状态，不保存私人文件路径、EXIF、内容哈希或恢复配方。 */
type ReferenceOutcome = {
  status:
    'prepared' | 'unmatched' | 'unsupported' | 'conflict' | 'skipped' | 'cleaned' | 'absent' | 'indexed' | 'refreshed';
};

/**
 * 显式启用的上传关联协调器；历史暂存和有可信来源的常规上传保留官方完整文件哈希。
 * 独立队列全局串行，事件及时入队，分页巡检补齐重启和事件失败；未匹配不阻塞备份。
 * 完成及失败任务均持久保留，同一版本不重复读原片，失败仅允许管理员显式重试。
 */
@Injectable()
export class IphoneBackupReconciliationService {
  private queue?: Queue<ReferenceJob, ReferenceOutcome>;
  private worker?: Worker<ReferenceJob, ReferenceOutcome>;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private stopping = false;
  private matchAfter?: string;
  private cleanupAfter?: string;
  private indexAfter?: string;
  private sourceAfter?: string;
  private sessionId?: string;
  private references: IphoneBackupReferenceService;
  private images: IphoneBackupImageRepository;
  private sources: IphoneBackupSourceService;

  /**
   * @param role 仅 microservices 进程消费和巡检。
   * @param db 当前实例数据库，所有操作仍限制到显式配置的库。
   * @param config 既有 BullMQ 连接与前缀配置，不连接其他缓存服务。
   * @param metadata 严格原片读取器，复用已有的无损恢复校验。
   * @param logger 标准日志，只记录资产 ID、计数和固定错误码。
   */
  constructor(
    @Inject(IWorker) private role: ImmichWorker,
    @InjectKysely() private db: Kysely<DB>,
    private config: ConfigRepository,
    private metadata: MetadataRepository,
    private logger: LoggingRepository,
    private jobs: JobRepository,
  ) {
    this.references = new IphoneBackupReferenceService(db, metadata);
    this.images = new IphoneBackupImageRepository(db);
    this.sources = new IphoneBackupSourceService(db, metadata);
    this.logger.setContext(IphoneBackupReconciliationService.name);
  }

  /** 仅管理员显式开启时启动；重启保留队列暂停、失败及已完成记录，不清空或恢复其他队列。 */
  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrap(): Promise<void> {
    if (process.env.IMMICH_FORK_IPHONE_BACKUP_AUTO_REFERENCES !== 'true' || !getIphoneBackupConfig()?.historicalRoot) {
      return;
    }
    const snapshotRoot = process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT;
    if (!snapshotRoot || !isAbsolute(snapshotRoot) || resolve(snapshotRoot) !== snapshotRoot) {
      throw new Error('Explicit immutable backup snapshot root is required');
    }
    const sessionId = process.env.IMMICH_FORK_IPHONE_BACKUP_REFERENCE_SESSION_ID;
    if (sessionId) this.sessionId = z.uuid().parse(sessionId);
    const options = this.config.getEnv().bull.config;
    this.queue = new Queue(IPHONE_REFERENCE_QUEUE, {
      ...options,
      defaultJobOptions: { attempts: 1, removeOnComplete: false, removeOnFail: false, stackTraceLimit: 0 },
    });
    this.queue.on('error', () => this.logger.error('Reference queue connection failed'));
    const client = await this.queue.client;
    // 原子递增只保存数值世代，不把私人文件指纹放入队列元数据。
    client.defineCommand('forkIphoneAdvanceImageGeneration', {
      numberOfKeys: 1,
      lua: "return redis.call('INCR', KEYS[1])",
    });
    // 生产者也跨进程短暂串行，避免同时收到数百个完成事件时各自看到相同空余容量。
    client.defineCommand('forkIphoneAdmitReferences', {
      numberOfKeys: 1,
      lua: "if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', 60000) then return 1 else return 0 end",
    });
    client.defineCommand('forkIphoneReleaseReferences', {
      numberOfKeys: 1,
      lua: "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
    });
    if (this.role !== ImmichWorker.Microservices) return;
    await this.queue.setGlobalConcurrency(1);
    this.worker = new Worker(IPHONE_REFERENCE_QUEUE, (job) => this.runJob(job), {
      ...options,
      concurrency: 1,
      maxStalledCount: 1,
    });
    this.worker.on('error', () => this.logger.error('Reference worker connection failed'));
    this.timer = setInterval(
      () => void this.reconcile().catch(() => this.logger.error('Reference polling failed')),
      POLL_INTERVAL_MS,
    );
    await this.reconcile();
  }

  /** 停止产生新任务，等待当前有限检查完成；未开始任务继续保留在 Redis。 */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.polling?.catch(() => this.logger.error('Reference polling failed during shutdown'));
    await this.worker?.close();
    await this.queue?.close();
  }

  /** @param event 已完成元数据提取和 Live Photo 关联的资产；入队失败由巡检补齐，不使官方元数据任务失败。 */
  @OnEvent({ name: 'AssetMetadataExtracted', workers: [ImmichWorker.Microservices] })
  async onMetadataExtracted(event: ArgOf<'AssetMetadataExtracted'>): Promise<void> {
    await this.enqueueAsset(event.assetId);
  }

  /** @param event 官方任务成功结果；预览生成后开始检查，视觉索引就绪后允许未命中的版本补查。 */
  @OnEvent({ name: 'JobSuccess', workers: [ImmichWorker.Microservices] })
  async onJobSuccess(event: ArgOf<'JobSuccess'>): Promise<void> {
    if (
      (event.job.name === JobName.SmartSearch || event.job.name === JobName.AssetGenerateThumbnails) &&
      event.response === JobStatus.Success
    ) {
      await this.enqueueAsset(event.job.data.id);
    }
  }

  /** @returns 已配置库内元数据就绪、尚未关联的 JPEG/PNG/HEIC 查询；不包含其他用户、回收站或 NAS 原片。 */
  private matchCandidates() {
    const backup = getIphoneBackupConfig()!;
    return (
      this.db
        .selectFrom('asset')
        .innerJoin('library', 'library.id', 'asset.libraryId')
        .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
        .leftJoin('smart_search', 'smart_search.assetId', 'asset.id')
        .select(['asset.id', 'asset.updateId'])
        .select(sql<boolean>`smart_search."assetId" IS NOT NULL`.as('hasEmbedding'))
        .where('asset.libraryId', '=', backup.libraryId)
        .whereRef('asset.ownerId', '=', 'library.ownerId')
        .where('library.deletedAt', 'is', null)
        .where('asset.deletedAt', 'is', null)
        .where('asset.isOffline', '=', false)
        .where('asset.isExternal', '=', true)
        .where('asset.backupChecksum', 'is', null)
        .where('asset.contentChecksum', 'is not', null)
        .where('asset_job_status.metadataExtractedAt', 'is not', null)
        // 预览必须先从手机版完整文件生成，不能让去重切换原片影响其方向和元数据解释。
        .where('asset.thumbhash', 'is not', null)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('asset_file')
              .select('id')
              .whereRef('asset_file.assetId', '=', 'asset.id')
              .where('asset_file.type', '=', AssetFileType.Preview)
              .where('asset_file.isEdited', '=', false),
          ),
        )
        .where((eb) =>
          eb.or([
            sql<boolean>`starts_with(asset."originalPath", ${`${backup.historicalRoot}/`})`,
            eb.and([
              sql<boolean>`starts_with(asset."originalPath", ${`${backup.root}/`})`,
              eb.exists(
                eb
                  .selectFrom('fork_iphone_upload_origin')
                  .select('assetId')
                  .whereRef('fork_iphone_upload_origin.assetId', '=', 'asset.id')
                  .whereRef('fork_iphone_upload_origin.originalPath', '=', 'asset.originalPath')
                  .whereRef('fork_iphone_upload_origin.checksum', '=', 'asset.contentChecksum'),
              ),
            ]),
          ]),
        )
        .where(sql<boolean>`asset."originalPath" ~* '[.](jpe?g|png|heic|heif)$'`)
    );
  }

  /** @param id 服务器事件提供的单个资产 UUID；只入队，绝不在上传或索引事件中读取原片。 */
  private async enqueueAsset(id: string): Promise<void> {
    if (!this.queue || this.stopping || this.role !== ImmichWorker.Microservices) return;
    try {
      const row = await this.matchCandidates().where('asset.id', '=', id).executeTakeFirst();
      if (row) await this.enqueue([{ ...row, action: 'match', generation: await this.generation() }]);
    } catch {
      this.logger.error('Reference enqueue failed; polling will recover');
    }
  }

  /**
   * 同一进程合并巡检请求；每种操作只安排一页有限任务，游标只在成功入队后推进。
   * @returns 本次巡检完成；连接错误传给调用者，后续巡检仍从未确认位置补齐。
   */
  async reconcile(): Promise<void> {
    if (!this.queue || this.stopping || this.role !== ImmichWorker.Microservices) return;
    this.polling ??= this.poll().finally(() => {
      this.polling = undefined;
    });
    await this.polling;
  }

  /** @returns 有界安排匹配、源复核、本体索引及已确认清理，不自动重试失败版本。 */
  private async poll(): Promise<void> {
    if ((await this.queue!.isPaused()) || (await this.pending()) >= MAX_PENDING) return;
    const generation = await this.generation();
    const matches = await this.matchCandidates()
      .$if(!!this.matchAfter, (query) => query.where('asset.id', '>', this.matchAfter!))
      .orderBy('asset.id')
      .limit(PAGE_SIZE)
      .execute();
    const matched = await this.enqueue(matches.map((row) => ({ ...row, action: 'match', generation })));
    if (matched < matches.length) {
      this.matchAfter = matches[matched - 1]?.id ?? this.matchAfter;
      return;
    }
    this.matchAfter = matches.at(-1)?.id;
    const backup = getIphoneBackupConfig()!;
    const library = await this.db
      .selectFrom('library')
      .select('ownerId')
      .where('id', '=', backup.libraryId)
      .where('deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
    // 每页只做廉价 stat；实际原片读取全部进入同一全局串行队列，不能压过正在等待的上传。
    if ((await this.pending()) < MAX_PENDING) {
      const rows = await this.images.sourceCandidates(
        library.ownerId,
        backup.libraryId,
        backup.historicalRoot!,
        PAGE_SIZE,
        this.sourceAfter,
      );
      if (!(await this.enqueueSources(rows, 'refresh'))) return;
      this.sourceAfter = rows.at(-1)?.id;
    }
    if ((await this.pending()) < MAX_PENDING) {
      const rows = await this.images.indexingCandidates(
        library.ownerId,
        backup.libraryId,
        backup.historicalRoot!,
        PAGE_SIZE,
        this.indexAfter,
      );
      if (!(await this.enqueueSources(rows, 'index'))) return;
      this.indexAfter = rows.at(-1)?.id;
    }
    if (!this.sessionId) return;
    const checkpoints = await this.db
      .selectFrom('session_sync_checkpoint')
      .select(['type', 'ack'])
      .where('sessionId', '=', this.sessionId)
      .where('type', '=', SyncEntityType.AssetV2)
      .executeTakeFirst();
    const ack = checkpoints && fromAck(checkpoints.ack);
    if (!ack || ack.type !== SyncEntityType.AssetV2 || !z.uuid().safeParse(ack.updateId).success) return;
    // 两个确认时间和游标均在 SQL 中过滤，避免微秒精度丢失造成过早入队；执行时再次完整复核。
    const cleanup = await this.db
      .selectFrom('asset')
      .innerJoin('session', (join) =>
        join.on('session.id', '=', this.sessionId!).onRef('session.userId', '=', 'asset.ownerId'),
      )
      .innerJoin('session_sync_checkpoint as asset_ack', (join) =>
        join.onRef('asset_ack.sessionId', '=', 'session.id').on('asset_ack.type', '=', SyncEntityType.AssetV2),
      )
      .innerJoin('session_sync_checkpoint as complete_ack', (join) =>
        join
          .onRef('complete_ack.sessionId', '=', 'session.id')
          .on('complete_ack.type', '=', SyncEntityType.SyncCompleteV1),
      )
      .select(['asset.id', 'asset.updateId'])
      .where('asset.libraryId', '=', backup.libraryId)
      .where('asset.backupChecksum', 'is not', null)
      .where((eb) =>
        eb.or([
          sql<boolean>`starts_with(asset."backupOriginalPath", ${`${backup.historicalRoot}/`})`,
          eb.and([
            sql<boolean>`starts_with(asset."backupOriginalPath", ${`${backup.root}/`})`,
            eb.exists(
              eb
                .selectFrom('fork_iphone_upload_origin')
                .select('assetId')
                .whereRef('fork_iphone_upload_origin.assetId', '=', 'asset.id')
                .whereRef('fork_iphone_upload_origin.originalPath', '=', 'asset.backupOriginalPath')
                .whereRef('fork_iphone_upload_origin.checksum', '=', 'asset.backupChecksum'),
            ),
          ]),
        ]),
      )
      .where('asset.isOffline', '=', false)
      .where('asset.deletedAt', 'is', null)
      .where('session.isPendingSyncReset', '=', false)
      .whereRef('asset_ack.updatedAt', '>=', 'asset.updatedAt')
      .whereRef('complete_ack.updatedAt', '>=', 'asset.updatedAt')
      .where('asset.updateId', '<=', ack.updateId!)
      .$if(!!this.cleanupAfter, (query) => query.where('asset.id', '>', this.cleanupAfter!))
      .orderBy('asset.id')
      .limit(PAGE_SIZE)
      .execute();
    const cleaned = await this.enqueue(cleanup.map((row) => ({ ...row, action: 'cleanup' })));
    if (cleaned < cleanup.length) {
      this.cleanupAfter = cleanup[cleaned - 1]?.id ?? this.cleanupAfter;
      return;
    }
    this.cleanupAfter = cleanup.at(-1)?.id;
  }

  /** @param items 已限制归属的有限任务。@returns 本页已接收数，锁竞争或背压不推进未接收游标。 */
  private async enqueue(items: ReferenceJob[]): Promise<number> {
    if (items.length === 0) return 0;
    const client = await this.queue!.client;
    const admissionKey = this.queue!.toKey('producer-admission');
    const token = randomUUID();
    if (!(await client.runCommand('forkIphoneAdmitReferences', [admissionKey, token]))) return 0;
    try {
      const capacity = Math.max(0, MAX_PENDING - (await this.pending()));
      const available = items
        .slice(0, capacity)
        .map((data) =>
          data.action === 'cleanup'
            ? { ...data, cleanupCapability: CLEANUP_CAPABILITY }
            : { ...data, formatCapability: FORMAT_CAPABILITY },
        );
      for (const data of available) {
        const previous = await Job.fromId<ReferenceJob, ReferenceOutcome>(this.queue!, this.jobId(data));
        if (!previous || (await previous.getState()) !== 'completed') continue;
        const indexAdvanced =
          data.action === 'match' &&
          previous.data.action === 'match' &&
          ['unmatched', 'conflict'].includes(previous.returnvalue?.status) &&
          (previous.data.generation ?? 0) < data.generation;
        const formatsAdvanced =
          data.action !== 'cleanup' &&
          previous.returnvalue?.status === 'unsupported' &&
          (previous.data.formatCapability ?? 1) < FORMAT_CAPABILITY;
        const cleanupAdvanced =
          data.action === 'cleanup' &&
          previous.data.action === 'cleanup' &&
          ['cleaned', 'absent'].includes(previous.returnvalue?.status) &&
          (previous.data.cleanupCapability ?? 0) < CLEANUP_CAPABILITY &&
          (await this.images.hasRedundantUploadSnapshot(data.id, getIphoneBackupConfig()!.libraryId));
        // 保留任务身份；自有底稿能力升级只重放有精确遗留记录的旧成功任务，失败和在途任务均不动。
        if (!indexAdvanced && !formatsAdvanced && !cleanupAdvanced) continue;

        await previous.updateData(data);
        try {
          await previous.retry('completed');
        } catch (error) {
          if (!['waiting', 'active', 'completed'].includes(await previous.getState())) throw error;
        }
      }
      await this.queue!.addBulk(
        available.map((data) => ({
          name: data.action,
          data,
          opts: {
            jobId: this.jobId(data),
            priority: data.action === 'match' ? 1 : data.action === 'cleanup' ? 2 : data.action === 'refresh' ? 3 : 4,
          },
        })),
      );
      return available.length;
    } finally {
      await client.runCommand('forkIphoneReleaseReferences', [admissionKey, token]);
    }
  }

  /** @param data 有界任务描述。@returns 不含文件路径或内容哈希的稳定键；失败同版本不会被新扫描覆盖。 */
  private jobId(data: ReferenceJob): string {
    const suffix =
      data.action === 'match'
        ? data.hasEmbedding
          ? 'clip'
          : 'time'
        : data.action === 'index' || data.action === 'refresh'
          ? data.signature
          : '';
    return `${data.action}-${data.id}-${data.updateId}${suffix ? `-${suffix}` : ''}`;
  }

  /** @returns 等待或执行的任务数；完成及失败记录不占生产者的背压额度。 */
  private async pending(): Promise<number> {
    const counts = await this.queue!.getJobCounts('wait', 'active', 'prioritized', 'delayed');
    return Object.values(counts).reduce((total, count) => total + count, 0);
  }

  /** @returns 持久索引世代；每次真实索引推进才递增，重启及多消费者使用相同的 Redis 值。 */
  private async generation(): Promise<number> {
    const client = await this.queue!.client;
    return Number((await client.get(this.queue!.toKey('image-generation'))) ?? 0);
  }

  /**
   * 有界 stat 巡检只入队变化的文件，文件读取错误也通过固定任务键保留失败，不每轮重试。
   * @param rows 仓库已经限制归属、独立原片和历史目录的有限候选。
   * @param action 缺失索引或已有依赖的源复核。
   */
  private async enqueueSources(
    rows: Awaited<ReturnType<IphoneBackupImageRepository['sourceCandidates']>>,
    action: 'index' | 'refresh',
  ): Promise<boolean> {
    const jobs: ReferenceJob[] = [];
    for (const row of rows) {
      let signature: string;
      try {
        signature = await this.signature(row.originalPath);
      } catch {
        signature = 'unavailable';
      }
      if (
        action === 'refresh' &&
        signature === row.cachedSignature &&
        row.contentChecksum &&
        row.cachedChecksum?.equals(row.contentChecksum)
      )
        continue;
      jobs.push({
        action,
        id: row.id,
        updateId: row.updateId,
        signature: createHash('sha256').update(signature).digest('hex'),
      });
    }
    return (await this.enqueue(jobs)) === jobs.length;
  }

  /** @param filename 已限制为当前库的绝对路径。@returns 纳秒 stat 签名；拒绝符号链接和非常规文件。 */
  private async signature(filename: string): Promise<string> {
    const stat = await lstat(filename, { bigint: true });
    if (!stat.isFile() || (await realpath(filename)) !== filename) throw new Error('Unsafe image index source');
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  /**
   * 读取实际文件发布严格索引，来源变化先走引用恢复；普通 NAS 导入没有上传清理权限。
   * @param data 同一全局串行队列中的源任务快照。
   * @returns 安全执行状态；不支持的格式保留原片，错误保留任务供管理员显式重试。
   */
  private async indexSource(data: Extract<ReferenceJob, { action: 'index' | 'refresh' }>): Promise<ReferenceOutcome> {
    const backup = getIphoneBackupConfig()!;
    const source = await this.db
      .selectFrom('asset')
      .innerJoin('library', 'library.id', 'asset.libraryId')
      .selectAll('asset')
      .select('library.importPaths')
      .where('asset.id', '=', data.id)
      .where('asset.libraryId', '=', backup.libraryId)
      .whereRef('asset.ownerId', '=', 'library.ownerId')
      .where('library.deletedAt', 'is', null)
      .where('asset.deletedAt', 'is', null)
      .where('asset.isOffline', '=', false)
      .where('asset.isExternal', '=', true)
      .where('asset.backupChecksum', 'is', null)
      .executeTakeFirstOrThrow();
    const imports = await Promise.all(source.importPaths.map((folder) => realpath(folder)));
    if (
      isWithinDirectory(backup.historicalRoot!, source.originalPath) ||
      imports.every((folder) => !isWithinDirectory(folder, source.originalPath))
    )
      throw new Error('Image index source scope changed');
    const signature = await this.signature(source.originalPath);
    if (createHash('sha256').update(signature).digest('hex') !== data.signature) return { status: 'skipped' };
    const dependents = await this.db
      .selectFrom('asset')
      .select('id')
      .where('backupSourceId', '=', source.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    const origin = await this.images.getUpload(source.id);
    // 只有已有引用或可信上传来源才进入恢复流程；任意 NAS 导入只参与只读候选索引。
    if (data.action === 'refresh' && !dependents && !origin) return { status: 'skipped' };
    try {
      const fresh = data.action === 'refresh' ? await this.refreshSource(source.id) : undefined;
      const image = fresh
        ? { checksum: fresh.checksum, signature: fresh.signature, image: fresh.imageFingerprint }
        : await readIphoneBackupImage(source.originalPath, this.metadata);
      const checksum = Buffer.from(image.checksum, 'hex');
      if (!source.contentChecksum?.equals(checksum) && !fresh) {
        if (dependents || origin) {
          await this.refreshSource(source.id);
        } else {
          await this.db.transaction().execute(async (tx) => {
            await sql`SELECT pg_advisory_xact_lock(${DatabaseLock.ForkIphoneBackup})`.execute(tx);
            const locked = await tx
              .selectFrom('asset')
              .selectAll()
              .where('id', '=', source.id)
              .forUpdate()
              .executeTakeFirstOrThrow();
            if (
              locked.updateId !== source.updateId ||
              locked.originalPath !== source.originalPath ||
              (await this.signature(source.originalPath)) !== image.signature
            )
              throw new Error('Image index source changed');
            await tx.updateTable('asset').set({ contentChecksum: checksum }).where('id', '=', source.id).execute();
          });
        }
      }
      const current = await this.db
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', source.id)
        .executeTakeFirstOrThrow();
      const file = await open(source.originalPath, 'r');
      const header = Buffer.alloc(8);
      try {
        await file.read(header, 0, header.length, 0);
      } finally {
        await file.close();
      }
      if ((await this.signature(source.originalPath)) !== image.signature)
        throw new Error('Image index source changed');
      const cached = await this.images.getFingerprint(source.id);
      await this.images.recordFingerprint({
        assetId: source.id,
        originalPath: current.originalPath,
        updateId: current.updateId,
        fileChecksum: checksum,
        imageFingerprint: image.image,
        signature: image.signature,
        // ftyp 只用于已经通过严格容器及编码验证的证据分类，不能单凭文件头或扩展名建立等价关系。
        format: header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? 'PNG'
          : header.toString('ascii', 4, 8) === 'ftyp'
            ? 'HEIC'
            : 'JPEG',
      });
      if (!cached || !cached.fileChecksum.equals(checksum) || cached.imageFingerprint !== image.image) {
        // 一个有限任务就是一批真实推进；下一页匹配及时重查，不等待全库扫描结束。
        const client = await this.queue!.client;
        await client.runCommand('forkIphoneAdvanceImageGeneration', [this.queue!.toKey('image-generation')]);
      }
      return { status: data.action === 'refresh' ? 'refreshed' : 'indexed' };
    } catch (error) {
      if (error instanceof UnsupportedIphoneBackupImageError) return { status: 'unsupported' };
      throw error;
    }
  }

  /**
   * 恢复源依赖后补排已落盘原始上传版本的官方元数据任务，处理事务提交后进程中断的恢复窗口。
   * @param id 已确认归属且具有引用或可信来源的独立原片。
   * @returns 源复核证明；自身预览由官方流程生成，不能借用 NAS 版本的方向或 EXIF。
   */
  private async refreshSource(id: string) {
    const result = await this.sources.refreshSource(id);
    if (result.recoveredAssetId) {
      const recovered = await this.db
        .selectFrom('asset')
        .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
        .select(['asset.id', 'asset.type', 'asset_job_status.metadataExtractedAt'])
        .where('asset.id', '=', result.recoveredAssetId)
        .where('asset.deletedAt', 'is', null)
        .executeTakeFirst();
      if (recovered && !recovered.metadataExtractedAt)
        await this.jobs.queue({
          name: JobName.AssetExtractMetadata,
          data: { id: recovered.id, source: 'upload', assetType: recovered.type },
        });
    }
    return result;
  }

  /**
   * 执行一个可重入任务；全局串行和已有数据库锁保护并发上传、扫描及手动处理。
   * @param job 已持久化的资产版本快照；不信任其为文件等价证明。
   * @returns 安全状态；异常只向队列传播固定错误码，完整文件保留并等待显式重试。
   */
  private async runJob(job: Job<ReferenceJob, ReferenceOutcome>): Promise<ReferenceOutcome> {
    try {
      const current = await this.db
        .selectFrom('asset')
        .select(['updateId', 'libraryId'])
        .where('id', '=', job.data.id)
        .executeTakeFirst();
      if (
        !current ||
        current.libraryId !== getIphoneBackupConfig()?.libraryId ||
        current.updateId !== job.data.updateId
      ) {
        return { status: 'skipped' };
      }
      if (job.data.action === 'index' || job.data.action === 'refresh') return await this.indexSource(job.data);
      if (job.data.action === 'cleanup') {
        if (!this.sessionId) throw new Error('Cleanup session not configured');
        const status = await this.references.cleanup(job.data.id, this.sessionId);
        this.logger.log(`Reference cleanup ${JSON.stringify({ assetId: job.data.id, status })}`);
        return { status };
      }
      const assessment = await this.references.assessAsset(job.data.id);
      if (!assessment) return { status: 'skipped' };
      if (assessment.status === 'unsafe') throw new Error('Unsafe reference assessment');
      if (assessment.status !== 'matched' || !assessment.plan)
        return { status: assessment.status === 'matched' ? 'skipped' : assessment.status };
      await this.references.prepare(assessment.plan);
      this.logger.log(`Reference prepared ${JSON.stringify({ assetId: job.data.id })}`);
      return { status: 'prepared' };
    } catch {
      throw new Error('REFERENCE_RECONCILIATION_FAILED');
    }
  }
}
