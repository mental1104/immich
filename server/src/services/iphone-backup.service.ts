import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import { performance } from 'node:perf_hooks';
import { IWorker } from 'src/constants.js';
import { OnEvent } from 'src/decorators.js';
import {
  IPHONE_BACKUP_BATCH_LIMIT,
  IphoneBackupBatchProgress,
  IphoneBackupCommandDto,
  IphoneBackupProgress,
} from 'src/dtos/iphone-backup.dto.js';
import { DatabaseLock, ImmichWorker } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { IphoneBackupRepository } from 'src/repositories/iphone-backup.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getIphoneBackupConcurrency, getIphoneBackupConfig } from 'src/utils/iphone-backup.js';

const QUEUE_NAME = 'fork-iphone-fingerprints';
const MAX_BATCH_BYTES = 8 * 1024 ** 3;
const RECONCILIATION_INTERVAL_MS = 5000;

/** 单个有限批次；是否接续由独立控制记录决定，libraryId 同时作为跨进程去重键。 */
interface FingerprintBatch {
  libraryId: string;
  limit: number;
}

/**
 * 管理外部库指纹的独立 BullMQ 队列；不改变官方队列枚举及手机 API。
 * Redis 持久化排队、暂停和失败状态，数据库保存逐项结果，重启后可安全重入。
 */
@Injectable()
export class IphoneBackupService {
  private queue?: Queue<FingerprintBatch, IphoneBackupBatchProgress>;
  private processor?: Worker<FingerprintBatch, IphoneBackupBatchProgress>;
  private stopping = false;
  private continuationTimer?: ReturnType<typeof setInterval>;
  private continuationTask?: Promise<void>;
  private continuationRequested = false;

  /**
   * @param role 当前进程角色，仅 microservices 消费任务。
   * @param config 已有 BullMQ 连接与前缀配置。
   * @param repository 指纹统计与条件补算的数据层。
   * @param logger 标准日志；只记录 ID、计数和安全错误码。
   * @param database 跨进程控制锁，串行化启动、暂停和已完成批次替换。
   */
  constructor(
    @Inject(IWorker) private role: ImmichWorker,
    private config: ConfigRepository,
    private repository: IphoneBackupRepository,
    private logger: LoggingRepository,
    private database: DatabaseRepository,
  ) {
    this.logger.setContext(IphoneBackupService.name);
  }

  /** 首次配置不创建任务；已授权的持续模式在重启后接续，管理员暂停状态保持不变。 */
  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrap() {
    if (!getIphoneBackupConfig()) {
      return;
    }
    // 在启动消费者前拒绝非法并发配置；单个队列任务仍保持全局串行。
    getIphoneBackupConcurrency();
    const options = this.config.getEnv().bull.config;
    this.queue = new Queue(QUEUE_NAME, {
      ...options,
      defaultJobOptions: { attempts: 1, removeOnComplete: false, removeOnFail: false, stackTraceLimit: 0 },
    });
    this.queue.on('error', () => this.logger.error('Fingerprint queue connection failed'));
    if (this.role !== ImmichWorker.Microservices) {
      return;
    }
    // 全局串行约束覆盖多个 worker 实例；单个库只有一个固定 jobId。
    await this.queue.setGlobalConcurrency(1);
    this.processor = new Worker(QUEUE_NAME, (job) => this.runBatch(job), {
      ...options,
      concurrency: 1,
      maxStalledCount: 1,
    });
    this.processor.on('error', () => this.logger.error('Fingerprint worker connection failed'));
    // 正常完成后立即协调下一批；定时器只负责丢事件和重启恢复，不再强制批间冷却。
    this.processor.on('completed', () => this.requestContinuation());
    this.continuationTimer = setInterval(() => this.requestContinuation(), RECONCILIATION_INTERVAL_MS);
    await this.continuePreparation();
  }

  /** 合并重叠的完成和巡检请求；保留已有协调过程中到达的完成信号，不丢失即时接续。 */
  private requestContinuation(): void {
    if (this.stopping) {
      return;
    }
    this.continuationRequested = true;
    if (this.continuationTask) {
      return;
    }
    this.continuationRequested = false;
    this.continuationTask = this.continuePreparation()
      .catch(() => this.logger.error('Fingerprint continuation failed'))
      .finally(() => {
        this.continuationTask = undefined;
        if (this.continuationRequested && !this.stopping) {
          this.requestContinuation();
        }
      });
  }

  /** 关闭时完成当前文件后退出，保留 Redis 和数据库结果供后续恢复。 */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    clearInterval(this.continuationTimer);
    await this.continuationTask;
    await this.processor?.close();
    await this.queue?.close();
  }

  /** @returns 管理页实时状态；统计不会启动任务，未配置时返回明确的 disabled 状态。 */
  async getProgress(): Promise<IphoneBackupProgress> {
    const backup = getIphoneBackupConfig();
    const empty = {
      enabled: false,
      uploadsEnabled: false,
      continuous: false,
      total: 0,
      ready: 0,
      pending: 0,
      state: 'disabled',
      batch: null,
    } as const;
    if (!backup || !this.queue) {
      return empty;
    }
    const [paused, job, control] = await Promise.all([
      this.queue.isPaused(),
      this.queue.getJob(backup.libraryId),
      this.readContinuation(backup.libraryId),
    ]);
    const jobState = await job?.getState();
    // 先读取任务状态，再统计数据库，避免刚结束的批次配上结束前的完成数。
    const counts = await this.repository.counts(backup.libraryId);
    const state =
      jobState === 'failed'
        ? 'failed'
        : jobState === 'active'
          ? 'running'
          : paused
            ? 'paused'
            : jobState === 'waiting' || jobState === 'delayed' || (control.enabled && counts.pending > 0)
              ? 'queued'
              : counts.pending === 0
                ? 'completed'
                : 'idle';
    const batch = job && typeof job.progress === 'object' ? (job.progress as IphoneBackupBatchProgress) : null;
    return {
      enabled: true,
      uploadsEnabled: process.env.IMMICH_FORK_IPHONE_BACKUP_UPLOADS_ENABLED !== 'false',
      continuous: control.enabled && counts.pending > 0,
      ...counts,
      state,
      batch,
    };
  }

  /**
   * 执行管理员命令；重试仅针对保留的失败批次，已完成项由数据库自动跳过。
   * @param dto 命令与 1..5000 的批次上限；continue 持久启用接续，start 仅处理单批。
   * @returns 命令后的实时状态；并发重复启动复用固定 jobId，不清空其他队列。
   */
  async command(dto: IphoneBackupCommandDto): Promise<IphoneBackupProgress> {
    const backup = getIphoneBackupConfig();
    if (!backup || !this.queue) {
      throw new BadRequestException('Fingerprint preparation is not configured');
    }
    return this.database.withLock(DatabaseLock.ForkIphoneBackupPreparation, async () => {
      if (dto.command === 'pause') {
        await this.queue!.pause();
        return this.getProgress();
      }
      const control = await this.readContinuation(backup.libraryId);
      const job = await this.queue!.getJob(backup.libraryId);
      const state = await job?.getState();
      if (dto.command === 'retry') {
        if (!job || state !== 'failed') {
          throw new ConflictException('No failed fingerprint batch to retry');
        }
        await job.retry('failed');
      } else {
        if (state === 'failed') {
          throw new ConflictException('Retry the failed fingerprint batch explicitly');
        }
        if (dto.command === 'start' || dto.command === 'continue') {
          await this.writeContinuation(backup.libraryId, dto.command === 'continue', dto.limit);
        }
        const limit = dto.command === 'resume' && control.enabled ? control.limit : dto.limit;
        await this.enqueueBatch(backup.libraryId, limit);
      }
      await this.queue!.resume();
      return this.getProgress();
    });
  }

  /**
   * 为显式开启的持续模式安排下一批；失败和暂停均保留，不能自动重试或恢复。
   * @returns 协调结束的 Promise；全库就绪后关闭接续，不追踪未来新增文件。
   */
  async continuePreparation(): Promise<void> {
    const backup = getIphoneBackupConfig();
    if (this.stopping || !backup || !this.queue) {
      return;
    }
    await this.database.withLock(DatabaseLock.ForkIphoneBackupPreparation, async () => {
      if (this.stopping || (await this.queue!.isPaused())) {
        return;
      }
      const control = await this.readContinuation(backup.libraryId);
      if (!control.enabled) {
        return;
      }
      const job = await this.queue!.getJob(backup.libraryId);
      if (job && (await job.getState()) !== 'completed') {
        return;
      }
      const counts = await this.repository.counts(backup.libraryId);
      if (counts.pending === 0) {
        await this.writeContinuation(backup.libraryId, false, control.limit);
        return;
      }
      await this.enqueueBatch(backup.libraryId, control.limit);
    });
  }

  /** @param libraryId 目标库。 @returns Redis 中原子保存的模式与合法批次大小；无记录时默认手动。 */
  private async readContinuation(libraryId: string) {
    const client = await this.queue!.client;
    const [enabled, rawLimit] = await client.hmget(this.queue!.toKey(`continuation-${libraryId}`), 'enabled', 'limit');
    const limit = Number(rawLimit ?? IPHONE_BACKUP_BATCH_LIMIT);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > IPHONE_BACKUP_BATCH_LIMIT) {
      throw new BadRequestException('Invalid fingerprint continuation limit');
    }
    return { enabled: enabled === 'true', limit };
  }

  /** @param libraryId 目标库。 @param enabled 是否显式启用接续。 @param limit 后续每批数量上限。 @returns 控制意图已原子写入 Redis。 */
  private async writeContinuation(libraryId: string, enabled: boolean, limit: number): Promise<void> {
    const client = await this.queue!.client;
    await client.hset(this.queue!.toKey(`continuation-${libraryId}`), {
      enabled: String(enabled),
      limit: String(limit),
    });
  }

  /**
   * 复用固定 jobId，只替换已完成的批次；调用者必须持有准备控制锁，防止跨进程误删新任务。
   * @param libraryId 目标库，也作为队列去重键。
   * @param limit 本批数量上限；读取字节限制仍由消费者逐文件检查。
   * @returns 任务已入队或已有未完成任务被保留；失败任务不会被删除。
   */
  private async enqueueBatch(libraryId: string, limit: number): Promise<void> {
    const job = await this.queue!.getJob(libraryId);
    if (job) {
      if ((await job.getState()) !== 'completed') {
        return;
      }
      await job.remove();
    }
    await this.queue!.add('prepare', { libraryId, limit }, { jobId: libraryId });
  }

  /**
   * 用最多两个文件组成的波次执行有界批次；超过字节预算的单文件独占一批，失败不隐式跳过。
   * @param job BullMQ 固定 ID 的持久化任务。
   * @returns 本次实际完成数、读取字节及停止原因；失败只向 Redis 记录安全错误码。
   */
  async runBatch(job: Job<FingerprintBatch, IphoneBackupBatchProgress>): Promise<IphoneBackupBatchProgress> {
    const started = performance.now();
    const progress: IphoneBackupBatchProgress = { completed: 0, bytes: 0 };
    try {
      const backup = getIphoneBackupConfig();
      if (
        !backup ||
        backup.libraryId !== job.data.libraryId ||
        !Number.isSafeInteger(job.data.limit) ||
        job.data.limit < 1 ||
        job.data.limit > IPHONE_BACKUP_BATCH_LIMIT
      ) {
        throw new Error('INVALID_BATCH');
      }
      const rows = await this.repository.candidates(backup.libraryId, job.data.limit);
      const concurrency = getIphoneBackupConcurrency();
      for (let offset = 0; offset < rows.length; offset += concurrency) {
        if (this.stopping || (await this.queue!.isPaused())) {
          progress.reason = 'paused';
          break;
        }
        // 普通文件共享 8 GiB 预算；超大文件仅能在空批次独占读取，避免永久阻塞后续资产。
        const wave = [];
        let reservedBytes = progress.bytes;
        for (const row of rows.slice(offset, offset + concurrency)) {
          progress.currentAssetId = row.id;
          const size = await this.repository.size(row);
          if (size > MAX_BATCH_BYTES) {
            progress.reason = 'budget';
            if (progress.completed === 0 && wave.length === 0) {
              // 沿用流式哈希，不按文件大小分配内存；本文件完成后立即结束批次。
              wave.push({ row, size });
            }
            break;
          }
          if (reservedBytes + size > MAX_BATCH_BYTES) {
            progress.reason = 'budget';
            break;
          }
          reservedBytes += size;
          wave.push({ row, size });
        }
        if (wave.length === 0) {
          break;
        }
        progress.currentAssetId = wave[0].row.id;
        await job.updateProgress({ ...progress });
        const outcomes = await Promise.allSettled(
          wave.map(({ row, size }) => this.repository.prepare(backup.libraryId, row, size)),
        );
        let failure: { assetId: string; error: unknown } | undefined;
        // 等所有在途文件结束再记账：一项失败时保留另一项的成功结果和真实字节数。
        for (const [index, outcome] of outcomes.entries()) {
          if (outcome.status === 'fulfilled') {
            progress.bytes += outcome.value;
            progress.completed++;
          } else {
            failure ??= { assetId: wave[index].row.id, error: outcome.reason };
          }
        }
        if (failure) {
          delete progress.reason;
          progress.currentAssetId = failure.assetId;
          throw failure.error;
        }
        delete progress.currentAssetId;
        await job.updateProgress({ ...progress });
        if (progress.reason === 'budget') {
          break;
        }
      }
      progress.reason ??= rows.length < job.data.limit ? 'complete' : 'limit';
      delete progress.currentAssetId;
      await job.updateProgress({ ...progress });
      this.logger.log(
        `IphoneBackupBatch ${JSON.stringify({ ...progress, concurrency, elapsedMs: Math.round(performance.now() - started) })}`,
      );
      return progress;
    } catch (error) {
      // 原始 fs/数据库异常可能含私人路径或 SQL；持久化和日志只接受白名单错误码。
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : error instanceof Error
            ? error.message
            : '';
      progress.errorCode = [
        'ENOENT',
        'EACCES',
        'EIO',
        'FILE_CHANGED',
        'ASSET_CHANGED',
        'FILE_TOO_LARGE',
        'NOT_REGULAR_FILE',
        'INVALID_BATCH',
      ].includes(code)
        ? code
        : 'PREPARATION_FAILED';
      await job.updateProgress({ ...progress });
      this.logger.error(
        `IphoneBackupBatch ${JSON.stringify({ ...progress, elapsedMs: Math.round(performance.now() - started) })}`,
      );
      // 底层异常包含原片路径时禁止附加 cause，防止 BullMQ 持久化私人信息。
      // eslint-disable-next-line preserve-caught-error
      throw new Error(progress.errorCode);
    }
  }
}
