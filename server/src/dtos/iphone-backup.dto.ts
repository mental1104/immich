import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** 每批文件数硬上限；独立的读取字节预算仍为 8 GiB。 */
export const IPHONE_BACKUP_BATCH_LIMIT = 5000;

/** 管理员显式启动单批或持续准备；不允许从请求指定其他库、文件路径或开启手机上传。 */
export class IphoneBackupCommandDto extends createZodDto(
  z.object({
    command: z.enum(['start', 'continue', 'pause', 'resume', 'retry']),
    limit: z.int().min(1).max(IPHONE_BACKUP_BATCH_LIMIT).default(IPHONE_BACKUP_BATCH_LIMIT),
  }),
) {}

/** Redis 保留的批次进度；不含文件名、原片路径或指纹。 */
export interface IphoneBackupBatchProgress {
  completed: number;
  bytes: number;
  currentAssetId?: string;
  errorCode?: string;
  reason?: 'limit' | 'budget' | 'paused' | 'complete';
}

/** 管理页专用状态；ready/pending 来自数据库，而非队列保留的历史完成数。 */
export interface IphoneBackupProgress {
  enabled: boolean;
  uploadsEnabled: boolean;
  continuous: boolean;
  total: number;
  ready: number;
  pending: number;
  state: 'disabled' | 'idle' | 'queued' | 'running' | 'paused' | 'failed' | 'completed';
  batch: IphoneBackupBatchProgress | null;
}
