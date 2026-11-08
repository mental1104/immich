import { Kysely, Selectable, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { BigIntStats, constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { ChecksumAlgorithm, DatabaseLock } from 'src/enum.js';
import { IphoneBackupImageRepository } from 'src/repositories/iphone-backup-image.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import {
  IphoneBackupImage,
  iphoneBackupImageExtension,
  readIphoneBackupImage,
  restoreIphoneBackupImage,
} from 'src/utils/iphone-backup-image.js';
import { createIphoneBackupSnapshot, readIphoneBackupSnapshot } from 'src/utils/iphone-backup-snapshot.js';
import { getIphoneBackupConfig, isWithinDirectory } from 'src/utils/iphone-backup.js';

/** 一次实际源文件复核结果；编码变化不被当成元数据修订，无法恢复的引用保持离线。 */
export interface IphoneBackupSourceRefresh {
  sourceId: string;
  status: 'unchanged' | 'refreshed' | 'image_changed';
  checksum: string;
  signature: string;
  restoredReferences: number;
  retainedReferences: number;
  invalidReferences: number;
  imageFingerprint: string;
  /** 初始上传已被 NAS 改写时恢复的完整手机版本；由协调器补齐元数据和预览任务。 */
  recoveredAssetId?: string;
}

type SourceAsset = Selectable<AssetTable>;

/**
 * 重新验证已被引用的 NAS JPEG/PNG；允许时间、GPS、标签重写，而不改变手机原文件身份。
 * 只有保存的恢复配方实际恢复出原完整 SHA-1 才能保持或恢复关联，不重写原片或暂存副本。
 */
export class IphoneBackupSourceService {
  /** @param db 当前实例的数据库连接。@param metadata 严格读取实际图像和元数据的既有访问器。 */
  constructor(
    private readonly db: Kysely<DB>,
    private readonly metadata: Pick<MetadataRepository, 'readBackupTags'>,
  ) {}

  /**
   * 在锁外取得完整 EXIF/图像证据，再在源行、引用行及发布锁内复核物理原片。
   * 共享 ExifTool 池的等待不占用上传发布锁；锁内仍验证真实文件和所有引用的完整恢复结果。
   * @param sourceId 队列从当前配置库选出的独立源资产 UUID，不接受文件路径或客户端的等价声明。
   * @returns 实际稳定文件的摘要、签名与恢复计数；读取、配方损坏或权限错误使整笔事务回滚。
   */
  async refreshSource(sourceId: string): Promise<IphoneBackupSourceRefresh> {
    const backup = getIphoneBackupConfig();
    if (!backup) throw new Error('Backup source refresh is not configured');
    const library = await this.db
      .selectFrom('library')
      .select(['ownerId', 'importPaths', 'deletedAt'])
      .where('id', '=', backup.libraryId)
      .executeTakeFirstOrThrow();
    if (library.deletedAt) throw new Error('Backup source library is deleted');
    const imports = await Promise.all(library.importPaths.map((folder) => realpath(folder)));
    const configuredRoot = process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT;
    if (!configuredRoot) throw new Error('Backup source snapshot root is not configured');
    const snapshotRoot = resolve(configuredRoot);
    if (
      !isAbsolute(configuredRoot) ||
      configuredRoot !== snapshotRoot ||
      imports.some((folder) => isWithinDirectory(folder, snapshotRoot) || isWithinDirectory(snapshotRoot, folder))
    ) {
      throw new Error('Unsafe backup snapshot root');
    }

    // 在任何文件读取前先核实归属和导入范围；长时间 EXIF 等待期间不占有发布锁或源行锁。
    const initial = await this.db.selectFrom('asset').selectAll().where('id', '=', sourceId).executeTakeFirstOrThrow();
    if (
      initial.ownerId !== library.ownerId ||
      initial.libraryId !== backup.libraryId ||
      initial.deletedAt ||
      initial.isOffline ||
      initial.backupChecksum ||
      initial.backupSourceId
    ) {
      throw new Error('Backup source ownership or availability changed');
    }
    if (imports.every((folder) => !isWithinDirectory(folder, initial.originalPath))) {
      throw new Error('Backup source is outside library imports');
    }
    const image = await readIphoneBackupImage(initial.originalPath, this.metadata);

    let createdPath: string | undefined;
    try {
      return await this.db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(${DatabaseLock.ForkIphoneBackup})`.execute(tx);
        const currentLibrary = await tx
          .selectFrom('library')
          .select(['ownerId', 'importPaths', 'deletedAt'])
          .where('id', '=', backup.libraryId)
          .executeTakeFirstOrThrow();
        if (
          currentLibrary.deletedAt ||
          currentLibrary.ownerId !== library.ownerId ||
          JSON.stringify(currentLibrary.importPaths) !== JSON.stringify(library.importPaths)
        ) {
          throw new Error('Backup source library changed before refresh');
        }
        // 与源状态传播和版本准备保持相同锁顺序：物理源优先，再按稳定 ID 顺序锁引用。
        const source = await tx
          .selectFrom('asset')
          .selectAll()
          .where('id', '=', sourceId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (
          source.ownerId !== library.ownerId ||
          source.libraryId !== backup.libraryId ||
          source.deletedAt ||
          source.isOffline ||
          source.backupChecksum ||
          source.backupSourceId
        ) {
          throw new Error('Backup source ownership or availability changed');
        }
        if (source.originalPath !== initial.originalPath) throw new Error('Backup source path changed before refresh');
        if (imports.every((folder) => !isWithinDirectory(folder, source.originalPath))) {
          throw new Error('Backup source is outside library imports');
        }
        const currentBytes = await this.readPreparedSource(source.originalPath, image);
        // 读取及证明均使用已完整校验的有界快照，避免在第二次读取 NAS 时追随变化的路径。
        const snapshot = await createIphoneBackupSnapshot({
          sourcePath: source.originalPath,
          sourceId: source.id,
          checksum: image.checksum,
          root: snapshotRoot,
        });
        const bytes = await readIphoneBackupSnapshot({
          path: snapshot.path,
          root: snapshotRoot,
          checksum: image.checksum,
        });
        if (
          !bytes.equals(currentBytes) ||
          createHash('sha1').update(bytes).digest('hex') !== image.checksum ||
          (await this.signature(source.originalPath)) !== image.signature
        ) {
          throw new Error('Backup source changed during refresh');
        }
        const recovered = await this.preserveUpload(tx, source, image.checksum, snapshotRoot);
        createdPath = recovered.path;
        const versions = await tx
          .selectFrom('asset')
          .selectAll()
          .where('backupSourceId', '=', source.id)
          .orderBy('id')
          .forUpdate()
          .execute();
        const proved: SourceAsset[] = [];
        const retained: SourceAsset[] = [];
        const invalid: SourceAsset[] = [];
        let imageChanged = false;
        let invalidReferences = 0;
        for (const version of versions) {
          // 删除、跨归属或损坏记录不能借自动复核恢复匹配；SQL 触发器仍保留其原有安全状态。
          if (version.deletedAt || version.ownerId !== source.ownerId || version.libraryId !== source.libraryId)
            continue;
          if (!version.backupChecksum || !version.backupMetadata || version.originalPath !== source.originalPath) {
            throw new Error('Invalid backup reference during refresh');
          }
          try {
            const restored = restoreIphoneBackupImage(bytes, version.backupMetadata);
            if (!createHash('sha1').update(restored).digest().equals(version.backupChecksum)) {
              throw new Error('Backup reference checksum mismatch during refresh');
            }
            proved.push(version);
          } catch (error) {
            // 仅明确的编码主体变化可按新图像处理；损坏 gzip、配方或原始校验和不能悄悄跳过。
            if (!(error instanceof Error) || error.message !== 'Backup recovery source image changed') throw error;
            imageChanged = true;
            const snapshot = version.contentChecksum
              ? await tx
                  .selectFrom('fork_iphone_source_snapshot')
                  .selectAll()
                  .where('sourceId', '=', source.id)
                  .where('checksum', '=', version.contentChecksum)
                  .executeTakeFirst()
              : undefined;
            if (!snapshot) {
              invalid.push(version);
              invalidReferences++;
              continue;
            }
            // 新图像不能代替旧图像；只有实际快照仍可完整恢复旧手机版本时才保留原匹配。
            const previous = await readIphoneBackupSnapshot({
              path: snapshot.path,
              root: snapshotRoot,
              checksum: snapshot.checksum.toString('hex'),
            });
            const restored = restoreIphoneBackupImage(previous, version.backupMetadata);
            if (!createHash('sha1').update(restored).digest().equals(version.backupChecksum)) {
              throw new Error('Pinned snapshot cannot recover backup reference', { cause: error });
            }
            retained.push(version);
          }
        }
        const checksum = Buffer.from(image.checksum, 'hex');
        // 发布新源校验和之前固定其当前字节；没有内容变化时也补齐旧引用的首次快照。
        // 源已由本事务锁定，实际 SHA-1 已验证，故可在更新源行前保存新字节的快照证据。
        const existing = await tx
          .selectFrom('fork_iphone_source_snapshot')
          .selectAll()
          .where('sourceId', '=', source.id)
          .where('checksum', '=', checksum)
          .executeTakeFirst();
        if (existing && existing.path !== snapshot.path) throw new Error('Conflicting immutable source snapshot');
        if (!existing)
          await tx
            .insertInto('fork_iphone_source_snapshot')
            .values({ sourceId: source.id, checksum, path: snapshot.path, signature: snapshot.signature })
            .execute();
        const sourceChanged = !source.contentChecksum?.equals(checksum);
        const refsChanged =
          proved.some((version) => version.isOffline || !version.contentChecksum?.equals(checksum)) ||
          retained.some((version) => version.isOffline);
        const invalidOnline = invalid.some((version) => !version.isOffline);
        if ((await this.signature(source.originalPath)) !== image.signature)
          throw new Error('Backup source changed before refresh commit');
        if (!sourceChanged && !refsChanged && !invalidOnline) {
          return {
            sourceId,
            status: imageChanged ? 'image_changed' : 'unchanged',
            checksum: image.checksum,
            signature: image.signature,
            restoredReferences: proved.length,
            retainedReferences: retained.length,
            invalidReferences,
            imageFingerprint: image.image,
            recoveredAssetId: recovered.id,
          };
        }

        // 证明只在本事务有效，绑定本源、实际完整 SHA-1 和逐项重建成功的引用 ID。
        // 源状态触发器可在同一行传播中保持原 clientChecksum，避免临时失效触发代表迁移。
        const proof = JSON.stringify({
          sourceId,
          checksum: image.checksum,
          versions: proved.map((version) => version.id),
        });
        await sql`SELECT set_config('immich.fork_iphone_reference_refresh', ${proof}, true)`.execute(tx);
        await tx.updateTable('asset').set({ contentChecksum: checksum }).where('id', '=', source.id).execute();
        await sql`SELECT set_config('immich.fork_iphone_reference_refresh', '', true)`.execute(tx);
        // 已由普通扫描更新过源指纹时，状态触发器可能不再触发；逐项证明仍能恢复已有离线引用。
        for (const version of proved) {
          await tx
            .updateTable('asset')
            .set({ contentChecksum: checksum, originalPath: source.originalPath, isOffline: false })
            .where('id', '=', version.id)
            .where('backupSourceId', '=', source.id)
            .where((eb) =>
              eb.or([
                eb('isOffline', '=', true),
                eb('contentChecksum', 'is distinct from', checksum),
                eb('originalPath', '!=', source.originalPath),
              ]),
            )
            .execute();
        }
        for (const version of invalid) {
          await tx
            .updateTable('asset')
            .set({ isOffline: true })
            .where('id', '=', version.id)
            .where('backupSourceId', '=', source.id)
            .where('isOffline', '=', false)
            .execute();
        }
        for (const version of retained) {
          // 旧图像的完整快照证明独立于当前 NAS 图像，只恢复可证明版本的在线状态，不迁移其固定摘要。
          await tx
            .updateTable('asset')
            .set({ isOffline: false })
            .where('id', '=', version.id)
            .where('backupSourceId', '=', source.id)
            .where('isOffline', '=', true)
            .execute();
        }
        if (retained.length > 0) {
          const rows = await tx
            .selectFrom('asset')
            .select(['id', 'isOffline', 'contentChecksum'])
            .where(
              'id',
              'in',
              retained.map((version) => version.id),
            )
            .execute();
          if (
            rows.some(
              (row) =>
                row.isOffline ||
                !row.contentChecksum?.equals(retained.find((version) => version.id === row.id)!.contentChecksum!),
            )
          ) {
            throw new Error('Pinned immutable reference was invalidated');
          }
        }
        if ((await this.signature(source.originalPath)) !== image.signature)
          throw new Error('Backup source changed before refresh commit');
        return {
          sourceId,
          status: imageChanged ? 'image_changed' : 'refreshed',
          checksum: image.checksum,
          signature: image.signature,
          restoredReferences: proved.length,
          retainedReferences: retained.length,
          invalidReferences,
          imageFingerprint: image.image,
          recoveredAssetId: recovered.id,
        };
      });
    } catch (error) {
      // 只回收本次事务新建的恢复文件；源照片、已有手机版本和私有底稿均不删除。
      if (createdPath) {
        try {
          await unlink(createdPath);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Original upload recovery rollback failed', {
            cause: cleanupError,
          });
        }
      }
      throw error;
    }
  }

  /**
   * 在发布锁内有界复读已取得完整 EXIF 证据的源文件，不再次等待共享 EXIF 进程池。
   * @param path 已由当前锁定资产确认且与锁外证据相同的绝对路径。
   * @param image 本次锁外实际读取的严格图像、完整 SHA-1 和稳定文件签名。
   * @returns 与证据绑定的完整原字节；换 inode、符号链接、增长、原地改写或摘要变化均拒绝。
   */
  private async readPreparedSource(path: string, image: IphoneBackupImage): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.size > 64n * 1024n * 1024n ||
        this.preparedSignature(before) !== image.signature ||
        (await realpath(path)) !== path
      ) {
        throw new Error('Backup source changed before refresh');
      }
      // 固定读取已证明的尺寸并探测额外字节，文件并发增长也不能触发无界分配。
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) throw new Error('Backup source changed before refresh');
        offset += read.bytesRead;
      }
      const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
      if (
        extra.bytesRead > 0 ||
        this.preparedSignature(await file.stat({ bigint: true })) !== image.signature ||
        this.preparedSignature(await lstat(path, { bigint: true })) !== image.signature ||
        (await realpath(path)) !== path ||
        createHash('sha1').update(bytes).digest('hex') !== image.checksum
      ) {
        throw new Error('Backup source changed before refresh');
      }
      return bytes;
    } finally {
      await file.close();
    }
  }

  /** @param stat 已读取的实际文件状态。@returns 与锁外完整图像证据使用相同字段的纳秒签名。 */
  private preparedSignature(stat: BigIntStats): string {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  /**
   * NAS 改写最初上传时，在同一事务内先恢复旧手机版本，再更新物理源摘要。
   * @param tx 已持有源行及发布锁的事务。@param source 可信配置库内的独立来源。
   * @param checksum 实际 NAS 完整摘要。@param snapshotRoot 已验证的私有底稿目录。
   * @returns 需补齐官方元数据任务的版本 ID，及只由本次事务创建的回滚文件路径。
   */
  private async preserveUpload(
    tx: Kysely<DB>,
    source: SourceAsset,
    checksum: string,
    snapshotRoot: string,
  ): Promise<{ id?: string; path?: string }> {
    const repository = new IphoneBackupImageRepository(tx);
    const origin = await repository.getUpload(source.id);
    if (!origin) return {};
    if (origin.recoveredAssetId) return { id: origin.recoveredAssetId };
    if (origin.checksum.toString('hex') === checksum) return {};
    const historicalRoot = getIphoneBackupConfig()?.historicalRoot;
    if (
      !historicalRoot ||
      origin.originalPath !== source.originalPath ||
      (await realpath(historicalRoot)) !== historicalRoot
    ) {
      throw new Error('Unsafe original upload recovery destination');
    }
    const saved = await repository.getSnapshot(source.id, origin.checksum);
    if (!saved) {
      if (origin.recovery) throw new Error('Original upload snapshot is missing');
      return {};
    }
    const baseline = await readIphoneBackupSnapshot({
      path: saved.path,
      checksum: origin.checksum.toString('hex'),
      root: snapshotRoot,
    });
    // 资料过大而未建立配方时，完整初始底稿本身仍是旧手机版本，不能因不能去重而丢失身份。
    const bytes = origin.recovery ? restoreIphoneBackupImage(baseline, origin.recovery) : baseline;
    if (!createHash('sha1').update(bytes).digest().equals(origin.checksum))
      throw new Error('Original upload recovery checksum mismatch');
    const directory = join(historicalRoot, '.fork-origin-versions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await realpath(directory)) !== directory) throw new Error('Unsafe original upload recovery directory');
    const id = randomUUID();
    const suffix = iphoneBackupImageExtension(bytes);
    const path = join(directory, `${id}.${suffix}`);
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      const original = origin.snapshot;
      await tx
        .insertInto('asset')
        .values({
          id,
          ownerId: source.ownerId,
          libraryId: source.libraryId,
          originalPath: path,
          originalFileName: original.originalFileName,
          fileCreatedAt: new Date(original.fileCreatedAt),
          fileModifiedAt: new Date(original.fileModifiedAt),
          type: original.type,
          isFavorite: original.isFavorite,
          visibility: original.visibility,
          duration: original.duration,
          livePhotoVideoId: original.livePhotoVideoId,
          localDateTime: new Date(original.localDateTime ?? original.fileCreatedAt),
          checksum: createHash('sha1').update(`path:${path}`).digest(),
          checksumAlgorithm: ChecksumAlgorithm.sha1Path,
          contentChecksum: origin.checksum,
          isExternal: true,
        })
        .execute();
      await repository.markRecovered(source.id, id);
      return { id, path };
    } catch (error) {
      await file.close();
      await unlink(path);
      throw error;
    }
  }

  /** @param path 已验证归属的源路径。@returns 纳秒文件签名；符号链接、非普通文件及解析后的不同路径直接失败。 */
  private async signature(path: string): Promise<string> {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isFile() || (await realpath(path)) !== path) throw new Error('Unsafe backup refresh source');
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }
}
