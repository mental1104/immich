import { DateTime } from 'luxon';
import path from 'node:path';
import z from 'zod';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';

/** 已完整接收的原片和伴随文件字节数，不包含 HTTP 或反向代理的缓冲字节。 */
type ReceivedBackupAudit = { ownerId: string; uploadId: string; mediaBytes: number; sidecarBytes: number };

/** 备份验收事件；只记录不透明 ID 和处理结果，不记录原片名、路径、内容哈希或 EXIF。 */
export type IphoneBackupAuditEvent =
  | { event: 'upload_stream_started'; uploadId: string }
  | { event: 'upload_stream_failed'; uploadId: string; mediaBytes: number }
  | (ReceivedBackupAudit & { event: 'upload_received' })
  | (ReceivedBackupAudit & { event: 'duplicate_after_receive'; assetId: string })
  | (ReceivedBackupAudit & {
      event: 'external_asset_created';
      assetId: string;
      libraryId: string;
      overwrite: false;
      historical?: boolean;
    })
  | (ReceivedBackupAudit & { event: 'upload_rolled_back'; assetId?: string; publishedFilesRemoved: number })
  | { event: 'header_duplicate'; ownerId: string; assetId: string; bodyParsed: false }
  | { event: 'upload_precheck'; ownerId: string; checked: number; duplicates: number }
  | { event: 'filename_collision'; uploadId: string; nextSuffix: number }
  | { event: 'fingerprint_ready'; assetId: string; libraryId: string }
  | { event: 'sync_asset_sent'; assetId: string; libraryId: string };

/**
 * 在显式开启验收日志时记录一个结构化事件；日志不构成客户端跳过上传的证明。
 * @param logger 当前服务的标准日志组件，保留请求关联 ID 和既有日志级别配置。
 * @param event 本次已经发生的处理结果，不接受原片名称、路径或内容。
 * @returns 无返回值；默认关闭，不改变 API 返回值或备份策略。
 */
export function logIphoneBackupAudit(logger: Pick<LoggingRepository, 'log'>, event: IphoneBackupAuditEvent): void {
  if (process.env.IMMICH_FORK_IPHONE_BACKUP_AUDIT === 'true') {
    logger.log(`IphoneBackupAudit ${JSON.stringify(event)}`);
  }
}

/** 管理员为单个外部库启用的 iPhone 备份目的地；root 必须是容器内的绝对目录。 */
export interface IphoneBackupConfig {
  libraryId: string;
  root: string;
  timeZone: string;
  minMonth?: string;
  /** 可选的历史上传暂存根目录；仅接收早于 minMonth 的文件，与常规归档根目录分离。 */
  historicalRoot?: string;
}

/**
 * 读取显式启用的备份配置；未设置 Library ID 时返回 undefined，错误配置直接失败。
 * @returns 指定库、常规根目录、可选历史暂存根及 EXIF 缺失时的时区；错误路径配置直接抛错。
 */
export function getIphoneBackupConfig(): IphoneBackupConfig | undefined {
  const libraryId = process.env.IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID;
  if (!libraryId) {
    return;
  }

  const root = process.env.IMMICH_FORK_IPHONE_BACKUP_ROOT;
  const timeZone = process.env.IMMICH_FORK_IPHONE_BACKUP_TIME_ZONE || 'Asia/Shanghai';
  const minMonth = process.env.IMMICH_FORK_IPHONE_BACKUP_MIN_MONTH;
  const historicalRoot = process.env.IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT || undefined;
  if (
    !z.uuid().safeParse(libraryId).success ||
    !root ||
    !path.isAbsolute(root) ||
    !DateTime.now().setZone(timeZone).isValid ||
    (minMonth !== undefined && !/^\d{4}(0[1-9]|1[0-2])$/.test(minMonth)) ||
    (historicalRoot !== undefined &&
      (!path.isAbsolute(historicalRoot) ||
        isWithinDirectory(path.resolve(root), path.resolve(historicalRoot)) ||
        isWithinDirectory(path.resolve(historicalRoot), path.resolve(root))))
  ) {
    throw new Error('Invalid iPhone backup configuration');
  }

  return {
    libraryId,
    root: path.resolve(root),
    timeZone,
    minMonth,
    historicalRoot: historicalRoot ? path.resolve(historicalRoot) : undefined,
  };
}

/**
 * 判断普通库扫描是否允许补算目标库内容指纹；抽样准备期间可独立关闭。
 * @param libraryId 本次扫描的外部库 UUID。
 * @returns 仅目标库且未显式暂停指纹扫描时为 true，不改变原有扫描和元数据任务。
 */
export function isIphoneBackupFingerprintingEnabled(libraryId: string): boolean {
  return (
    process.env.IMMICH_FORK_IPHONE_BACKUP_FINGERPRINT_SCAN !== 'false' &&
    getIphoneBackupConfig()?.libraryId === libraryId
  );
}

/** @returns 指纹补算同时处理的文件数，默认 1、最多 2；非法配置直接失败，避免无界磁盘并发。 */
export function getIphoneBackupConcurrency(): 1 | 2 {
  const value = process.env.IMMICH_FORK_IPHONE_BACKUP_CONCURRENCY ?? '1';
  if (value === '1' || value === '2') {
    return value === '2' ? 2 : 1;
  }
  throw new Error('Invalid iPhone fingerprint concurrency');
}

/**
 * 判断候选路径是否严格位于指定目录内，避免相同前缀和父目录跳转造成越界。
 * @param root 已规范化的根目录。
 * @param candidate 待检查的绝对路径。
 * @returns 路径等于根目录或位于其内部时为 true；不访问文件系统。
 */
export function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * 根据拍摄当地时间生成 YYYY/MM/IMG_yyyyMMdd_HHmmss，完整保留原始扩展名。
 * @param root 容器内备份根目录，不接受用户文件名作为路径片段。
 * @param capturedAt 已确定时区的拍摄时间；缺少 EXIF 时由调用者传入手机提供的创建时间。
 * @param originalName 客户端原始文件名，只提取其最后一个扩展名。
 * @returns 目标绝对路径；时间无效或扩展名不合法时抛错，避免错误归档。
 */
export function getIphoneBackupPath(root: string, capturedAt: DateTime, originalName: string): string {
  const extension = path.extname(originalName);
  if (!capturedAt.isValid || !/^\.[a-z\d]+$/i.test(extension)) {
    throw new Error('Invalid iPhone backup timestamp or extension');
  }

  return path.join(root, capturedAt.toFormat('yyyy/MM'), `IMG_${capturedAt.toFormat('yyyyMMdd_HHmmss')}${extension}`);
}
