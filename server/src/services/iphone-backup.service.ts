import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import { IWorker } from 'src/constants.js';
import { OnEvent } from 'src/decorators.js';
import { IphoneBackupBatchProgress, IphoneBackupCommandDto, IphoneBackupProgress } from 'src/dtos/iphone-backup.dto.js';
import { ImmichWorker } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { IphoneBackupRepository } from 'src/repositories/iphone-backup.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getIphoneBackupConfig } from 'src/utils/iphone-backup.js';

const QUEUE_NAME = 'fork-iphone-fingerprints';
const MAX_BATCH_BYTES = 8 * 1024 ** 3;

/** 单个有限批次，不自动续接下一批；libraryId 同时作为跨进程去重键。 */
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

  /**
   * @param role 当前进程角色，仅 microservices 消费任务。
   * @param config 已有 BullMQ 连接与前缀配置。
   * @param repository 指纹统计与条件补算的数据层。
   * @param logger 标准日志；只记录 ID、计数和安全错误码。
   */
  constructor(
    @Inject(IWorker) private role: ImmichWorker,
    private config: ConfigRepository,
    private repository: IphoneBackupRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(IphoneBackupService.name);
  }

  /** 配置启用时建立独立队列；不自动创建首批任务，也不恢复管理员的暂停状态。 */
  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrap() {
    if (!getIphoneBackupConfig()) {
      return;
    }
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
  }

  /** 关闭时完成当前文件后退出，保留 Redis 和数据库结果供后续恢复。 */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    await this.processor?.close();
    await this.queue?.close();
  }

  /** @returns 管理页实时状态；统计不会启动任务，未配置时返回明确的 disabled 状态。 */
  async getProgress(): Promise<IphoneBackupProgress> {
    const backup = getIphoneBackupConfig();
    const empty = {
      enabled: false,
      uploadsEnabled: false,
      total: 0,
      ready: 0,
      pending: 0,
      state: 'disabled',
      batch: null,
    } as const;
    if (!backup || !this.queue) {
      return empty;
    }
    const [counts, paused, job] = await Promise.all([
      this.repository.counts(backup.libraryId),
      this.queue.isPaused(),
      this.queue.getJob(backup.libraryId),
    ]);
    const jobState = await job?.getState();
    const state =
      jobState === 'failed'
        ? 'failed'
        : jobState === 'active'
          ? 'running'
          : paused
            ? 'paused'
            : jobState === 'waiting' || jobState === 'delayed'
              ? 'queued'
              : counts.pending === 0
                ? 'completed'
                : 'idle';
    const batch = job && typeof job.progress === 'object' ? (job.progress as IphoneBackupBatchProgress) : null;
    return {
      enabled: true,
      uploadsEnabled: process.env.IMMICH_FORK_IPHONE_BACKUP_UPLOADS_ENABLED !== 'false',
      ...counts,
      state,
      batch,
    };
  }

  /**
   * 执行管理员命令；重试仅针对保留的失败批次，已完成项由数据库自动跳过。
   * @param dto 命令与 1..1000 的批次上限；不接受客户端提供库或路径。
   * @returns 命令后的实时状态；并发重复启动复用固定 jobId，不清空其他队列。
   */
  async command(dto: IphoneBackupCommandDto): Promise<IphoneBackupProgress> {
    const backup = getIphoneBackupConfig();
    if (!backup || !this.queue) {
      throw new BadRequestException('Fingerprint preparation is not configured');
    }
    if (dto.command === 'pause') {
      await this.queue.pause();
      return this.getProgress();
    }
    const job = await this.queue.getJob(backup.libraryId);
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
      if (job && state === 'completed') {
        await job.remove();
      }
      await this.queue.add('prepare', { libraryId: backup.libraryId, limit: dto.limit }, { jobId: backup.libraryId });
    }
    await this.queue.resume();
    return this.getProgress();
  }

  /**
   * 串行执行有界批次；暂停在文件之间生效，任何文件失败均停止且不隐式跳过。
   * @param job BullMQ 固定 ID 的持久化任务。
   * @returns 本次实际完成数、读取字节及停止原因；失败只向 Redis 记录安全错误码。
   */
  async runBatch(job: Job<FingerprintBatch, IphoneBackupBatchProgress>): Promise<IphoneBackupBatchProgress> {
    const progress: IphoneBackupBatchProgress = { completed: 0, bytes: 0 };
    try {
      const backup = getIphoneBackupConfig();
      if (
        !backup ||
        backup.libraryId !== job.data.libraryId ||
        !Number.isSafeInteger(job.data.limit) ||
        job.data.limit < 1 ||
        job.data.limit > 1000
      ) {
        throw new Error('INVALID_BATCH');
      }
      const rows = await this.repository.candidates(backup.libraryId, job.data.limit);
      for (const row of rows) {
        if (this.stopping || (await this.queue!.isPaused())) {
          progress.reason = 'paused';
          break;
        }
        progress.currentAssetId = row.id;
        await job.updateProgress({ ...progress });
        const size = await this.repository.size(row);
        if (size > MAX_BATCH_BYTES) {
          throw new Error('FILE_TOO_LARGE');
        }
        if (progress.bytes + size > MAX_BATCH_BYTES) {
          progress.reason = 'budget';
          break;
        }
        progress.bytes += await this.repository.prepare(backup.libraryId, row, size);
        progress.completed++;
        delete progress.currentAssetId;
        await job.updateProgress({ ...progress });
      }
      progress.reason ??= rows.length < job.data.limit ? 'complete' : 'limit';
      delete progress.currentAssetId;
      await job.updateProgress({ ...progress });
      this.logger.log(`IphoneBackupBatch ${JSON.stringify(progress)}`);
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
      this.logger.error(`IphoneBackupBatch ${JSON.stringify(progress)}`);
      // 底层异常包含原片路径时禁止附加 cause，防止 BullMQ 持久化私人信息。
      // eslint-disable-next-line preserve-caught-error
      throw new Error(progress.errorCode);
    }
  }
}
