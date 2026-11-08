import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import { BigIntStats, constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { IphoneBackupImageRepository } from 'src/repositories/iphone-backup-image.repository.js';
import { DB } from 'src/schema/index.js';
import { UnsupportedIphoneBackupHeifError, isIphoneBackupHeif } from 'src/utils/iphone-backup-heif.js';
import { createIphoneBackupRecovery } from 'src/utils/iphone-backup-image.js';
import { createIphoneBackupSnapshot, readIphoneBackupSnapshot } from 'src/utils/iphone-backup-snapshot.js';
import { getIphoneBackupConfig, isWithinDirectory } from 'src/utils/iphone-backup.js';

/** 无损恢复与私有快照的共同大小上限；其他上传仍保留完整备份，不猜测可恢复性。 */
const MAX_RECOVERY_BYTES = 64 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 当前已发布文件的稳定实际证据，文件名和公开元数据均不决定编码格式。 */
interface UploadEvidence {
  checksum: Buffer;
  signature: string;
  supported: boolean;
}

/**
 * 仅在服务端成功发布新备份时固定来源身份，早于任何异步元数据提取或 NAS 管理软件改写。
 * 普通外部库扫描不发送此内部事件，公开 asset_metadata 不能创建可信来源。
 */
@Injectable()
export class IphoneBackupUploadService {
  /** @param db 当前实例数据库；调用者已经持有备份发布锁，本服务不重入跨连接发布锁。 */
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  /**
   * @param event 仅备份上传发布路径发送的新资产 ID，不接收客户端提供的来源声明。
   * @returns 完成或幂等复用可信来源；文件变化、摘要不符、快照异常使上传沿用原有回滚流程。
   */
  @OnEvent({ name: 'ForkIphoneBackupUpload' })
  async onBackupUpload(event: ArgOf<'ForkIphoneBackupUpload'>): Promise<void> {
    const backup = getIphoneBackupConfig();
    if (!backup) return;
    await this.db.transaction().execute(async (tx) => {
      const asset = await tx
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', event.assetId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        asset.libraryId !== backup.libraryId ||
        !asset.isExternal ||
        asset.backupChecksum ||
        asset.backupSourceId ||
        asset.deletedAt ||
        asset.isOffline
      )
        return;
      const library = await tx
        .selectFrom('library')
        .select(['ownerId', 'deletedAt', 'importPaths'])
        .where('id', '=', backup.libraryId)
        .executeTakeFirstOrThrow();
      if (library.deletedAt || library.ownerId !== asset.ownerId) throw new Error('Upload source ownership changed');
      const roots = await Promise.all(
        [backup.root, ...(backup.historicalRoot ? [backup.historicalRoot] : [])].map((folder) => realpath(folder)),
      );
      if (roots.every((folder) => !isWithinDirectory(folder, asset.originalPath))) return;
      const imports = await Promise.all(library.importPaths.map((folder) => realpath(folder)));
      if (roots.some((folder) => imports.every((parent) => !isWithinDirectory(parent, folder)))) {
        throw new Error('Upload origin is outside library imports');
      }
      const repository = new IphoneBackupImageRepository(tx);
      // 来源只在上传时建立一次；重投内部事件不能把后来的 NAS 元数据版本覆盖到原始版本。
      if (await repository.getUpload(asset.id)) return;
      const evidence = await this.readEvidence(asset.originalPath);
      if (!asset.contentChecksum?.equals(evidence.checksum)) throw new Error('Published upload checksum mismatch');
      let recovery: Buffer | null = null;
      if (evidence.supported) {
        const root = process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT;
        if (
          !root ||
          !isAbsolute(root) ||
          root !== resolve(root) ||
          imports.some((folder) => isWithinDirectory(folder, root) || isWithinDirectory(root, folder))
        ) {
          throw new Error('Private upload snapshot root is required');
        }
        let snapshot: Awaited<ReturnType<typeof createIphoneBackupSnapshot>> | undefined;
        try {
          snapshot = await createIphoneBackupSnapshot({
            sourceId: asset.id,
            sourcePath: asset.originalPath,
            root,
            checksum: evidence.checksum.toString('hex'),
          });
        } catch (error) {
          // 识别 HEIF 品牌不等于结构可恢复；未知结构保留完整上传，I/O、摘要及权限错误继续失败。
          if (!(error instanceof UnsupportedIphoneBackupHeifError)) throw error;
        }
        if (snapshot) {
          const bytes = await readIphoneBackupSnapshot({ path: snapshot.path, root, checksum: snapshot.checksum });
          // 恢复配方只是优化：纯字节分段超限时仍保留已验证的完整文件和初始快照。
          try {
            recovery = createIphoneBackupRecovery(bytes, bytes);
          } catch {
            recovery = null;
          }
          await repository.recordSnapshot({
            sourceId: asset.id,
            sourcePath: asset.originalPath,
            ownerId: asset.ownerId,
            libraryId: backup.libraryId,
            checksum: evidence.checksum,
            path: snapshot.path,
            signature: snapshot.signature,
          });
        }
      }
      if ((await this.signature(asset.originalPath)) !== evidence.signature)
        throw new Error('Upload changed before capture');
      await repository.captureUpload({
        assetId: asset.id,
        ownerId: asset.ownerId,
        libraryId: backup.libraryId,
        originalPath: asset.originalPath,
        checksum: evidence.checksum,
        recovery,
        snapshot: {
          originalFileName: asset.originalFileName,
          fileCreatedAt: asset.fileCreatedAt.toISOString(),
          fileModifiedAt: asset.fileModifiedAt.toISOString(),
          localDateTime: asset.localDateTime.toISOString(),
          type: asset.type,
          isFavorite: asset.isFavorite,
          visibility: asset.visibility,
          livePhotoVideoId: asset.livePhotoVideoId,
          duration: asset.duration,
        },
      });
    });
  }

  /** @param stats 实际普通文件的纳秒状态。@returns 检测原地写入与路径替换的签名。 */
  private statSignature(stats: BigIntStats): string {
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  }

  /** @param path 已限定发布范围的规范路径。@returns 当前稳定路径签名；符号链接与非普通文件拒绝。 */
  private async signature(path: string): Promise<string> {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile() || !isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path) {
      throw new Error('Unsafe published upload path');
    }
    return this.statSignature(stats);
  }

  /**
   * 有界内存计算实际完整 SHA-1；较大视频或未支持格式不会被读进单个缓冲区。
   * @param path 新发布的普通文件路径，不跟随最终符号链接。
   * @returns 稳定实际摘要与按魔数、大小决定的恢复支持状态；任何读错误均抛出。
   */
  private async readEvidence(path: string): Promise<UploadEvidence> {
    const before = await this.signature(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile() || this.statSignature(stats) !== before) throw new Error('Published upload changed');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      const hash = createHash('sha1');
      let total = 0;
      let supported = false;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
        if (!bytesRead) break;
        const bytes = buffer.subarray(0, bytesRead);
        if (total === 0)
          supported =
            bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER) ||
            (bytes.length >= 4 && bytes.readUInt16BE(0) === 0xff_d8) ||
            isIphoneBackupHeif(bytes);
        hash.update(bytes);
        total += bytesRead;
        if (BigInt(total) > stats.size) throw new Error('Published upload grew during capture');
      }
      if (
        BigInt(total) !== stats.size ||
        this.statSignature(await handle.stat({ bigint: true })) !== before ||
        (await this.signature(path)) !== before
      )
        throw new Error('Published upload changed during capture');
      return { checksum: hash.digest(), signature: before, supported: supported && total <= MAX_RECOVERY_BYTES };
    } finally {
      await handle.close();
    }
  }
}
