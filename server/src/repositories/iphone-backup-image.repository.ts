import { Injectable } from '@nestjs/common';
import { Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { isAbsolute, resolve } from 'node:path';
import { AssetType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { IphoneBackupUploadSnapshot } from 'src/schema/tables/fork-iphone-upload-origin.table.js';

/** 严格指纹提交的文件与资产乐观快照；调用者已验证读取期间文件未变。 */
export interface IphoneImageFingerprintInput {
  assetId: string;
  originalPath: string;
  updateId: string;
  fileChecksum: Buffer;
  imageFingerprint: string;
  signature: string;
  format: 'JPEG' | 'PNG' | 'HEIC';
}

/** 仅可信上传处理器可提交的初始来源；日期、标签等不是文件身份的证明。 */
export interface IphoneUploadOriginInput {
  assetId: string;
  ownerId: string;
  libraryId: string;
  originalPath: string;
  checksum: Buffer;
  recovery: Buffer | null;
  snapshot: IphoneBackupUploadSnapshot;
}

/** 专用快照工具已验证的不可变副本；签名描述快照自身，而 sourcePath 描述当前来源。 */
export interface IphoneSourceSnapshotInput {
  sourceId: string;
  ownerId: string;
  libraryId: string;
  sourcePath: string;
  checksum: Buffer;
  path: string;
  signature: string;
}

/** 仅用于已完整证明可从另一源恢复的可信上传版本；删除绑定精确键、路径和已检查的文件签名。 */
export interface IphoneRedundantSnapshotInput {
  assetId: string;
  checksum: Buffer;
  path: string;
  signature: string;
}

/**
 * 持久保存本体候选、可信上传来源和已固定的物理源快照，不更改原片或客户端匹配。
 * 只把实际编码指纹用作索引；最终共用及清理仍由业务服务再次读取完整字节确认。
 */
@Injectable()
export class IphoneBackupImageRepository {
  /** @param db 当前实例连接或调用者已经持有的事务，事务内不会另借连接。 */
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * 对指定资产加行锁再执行短数据库写入，避免在校验和提交间被扫描或删除改变。
   * @param assetId 当前快照对应的资产 UUID。
   * @param action 只使用同一连接及锁定资产的回调，不应在回调内读取大文件或另建事务。
   * @returns 回调结果；不存在资产时抛错，任何错误回滚本次独立事务或传给外层事务。
   */
  private async withAssetLock<T>(
    assetId: string,
    action: (db: Kysely<DB>, asset: Selectable<AssetTable>) => Promise<T>,
  ): Promise<T> {
    /** @param connection 当前连接。@returns 在当前连接的行锁保护下执行 action 的结果。 */
    const run = async (connection: Kysely<DB>): Promise<T> => {
      const asset = await connection
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', assetId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      return action(connection, asset);
    };
    // 父业务事务可能已经持有源行锁；在相同事务中重入，而不是新开连接等待自己。
    return this.db.isTransaction ? run(this.db) : this.db.transaction().execute(run);
  }

  /**
   * 写入一个稳定文件版本的索引；资产内容、路径或版本变化时拒绝旧结果。
   * @param input 实际文件读取及严格 JPEG/PNG/HEIC 校验产生的证据，不接受相似度结论。
   * @returns 已保存的记录；不更新 asset 的任何字段，不触发客户端重新匹配。
   */
  async recordFingerprint(input: IphoneImageFingerprintInput) {
    if (
      input.fileChecksum.length !== 20 ||
      !/^[a-f\d]{64}(?::[a-f\d]{64}){1,2}$/.test(input.imageFingerprint) ||
      !input.signature ||
      !['JPEG', 'PNG', 'HEIC'].includes(input.format)
    )
      throw new Error('Invalid image fingerprint evidence');
    return this.withAssetLock(input.assetId, async (db, asset) => {
      if (
        asset.backupChecksum ||
        asset.deletedAt ||
        asset.isOffline ||
        asset.originalPath !== input.originalPath ||
        asset.updateId !== input.updateId ||
        !asset.contentChecksum?.equals(input.fileChecksum)
      ) {
        throw new Error('Image fingerprint asset changed');
      }
      const record = {
        assetId: input.assetId,
        fileChecksum: input.fileChecksum,
        imageFingerprint: input.imageFingerprint,
        signature: input.signature,
        format: input.format,
      };
      return db
        .insertInto('fork_iphone_image_fingerprint')
        .values(record)
        .onConflict((conflict) => conflict.column('assetId').doUpdateSet(record))
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  /** @param assetId 资产 UUID。@returns 该资产缓存的文件版本证据；无记录时为 undefined，不读取原片。 */
  getFingerprint(assetId: string) {
    return this.db
      .selectFrom('fork_iphone_image_fingerprint')
      .selectAll()
      .where('assetId', '=', assetId)
      .executeTakeFirst();
  }

  /**
   * 按本体指纹找同用户同库的在线独立来源，不要求拍摄时间、GPS、标签或文件名相同。
   * @param ownerId 调用者已经鉴权的所属用户。
   * @param libraryId 已明确配置的图库。
   * @param imageFingerprint 严格编码指纹，不是视觉向量或像素近似分数。
   * @param excludeId 当前手机版本或当前来源，始终排除自身。
   * @param limit 结果上限 1..64；大量相同副本仍只提供有界候选。
   * @returns 候选资产；缓存完整 SHA-1 与当前资产不一致的陈旧记录不会命中。
   */
  findByImage(ownerId: string, libraryId: string, imageFingerprint: string, excludeId: string, limit = 64) {
    this.requireLimit(limit, 64);
    return this.db
      .selectFrom('fork_iphone_image_fingerprint as fingerprint')
      .innerJoin('asset', 'asset.id', 'fingerprint.assetId')
      .innerJoin('library', 'library.id', 'asset.libraryId')
      .selectAll('asset')
      .where('fingerprint.imageFingerprint', '=', imageFingerprint)
      .whereRef('fingerprint.fileChecksum', '=', 'asset.contentChecksum')
      .where('asset.id', '!=', excludeId)
      .where('asset.ownerId', '=', ownerId)
      .where('asset.libraryId', '=', libraryId)
      .whereRef('library.ownerId', '=', 'asset.ownerId')
      .where('library.deletedAt', 'is', null)
      .where('asset.backupChecksum', 'is', null)
      .where('asset.deletedAt', 'is', null)
      .where('asset.isOffline', '=', false)
      .orderBy('asset.createdAt')
      .orderBy('asset.id')
      .limit(limit)
      .execute();
  }

  /**
   * 持久记录可信上传来源；只创建一次，不允许后来覆盖最初手机版本的哈希和恢复资料。
   * @param input 服务端接收上传后取得的归属、路径、完整 SHA-1 及原始恢复配方。
   * @returns 新建或幂等复用的原始来源记录；不一致的路径或哈希会失败。
   */
  async captureUpload(input: IphoneUploadOriginInput) {
    if (
      input.checksum.length !== 20 ||
      (input.recovery !== null && (input.recovery.length === 0 || input.recovery.length > 1024 * 1024))
    ) {
      throw new Error('Invalid upload origin evidence');
    }
    return this.withAssetLock(input.assetId, async (db, asset) => {
      if (
        asset.ownerId !== input.ownerId ||
        asset.libraryId !== input.libraryId ||
        !asset.isExternal ||
        asset.backupChecksum ||
        asset.deletedAt ||
        asset.isOffline ||
        asset.originalPath !== input.originalPath ||
        !asset.contentChecksum?.equals(input.checksum)
      ) {
        throw new Error('Upload origin asset changed');
      }
      const existing = await db
        .selectFrom('fork_iphone_upload_origin')
        .selectAll()
        .where('assetId', '=', input.assetId)
        .executeTakeFirst();
      if (existing) {
        if (existing.originalPath !== input.originalPath || !existing.checksum.equals(input.checksum))
          throw new Error('Conflicting upload origin');
        return existing;
      }
      return db
        .insertInto('fork_iphone_upload_origin')
        .values({
          assetId: input.assetId,
          originalPath: input.originalPath,
          checksum: input.checksum,
          recovery: input.recovery,
          snapshot: input.snapshot,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  /** @param assetId 已验证归属的资产 UUID。@returns 最初的可信上传来源；无记录就不能授权常规目录清理。 */
  getUpload(assetId: string) {
    return this.db
      .selectFrom('fork_iphone_upload_origin')
      .selectAll()
      .where('assetId', '=', assetId)
      .executeTakeFirst();
  }

  /**
   * 固定已经恢复的手机版本身份，保留被用户删除的历史 ID，防止后台不断复活已删除资产。
   * @param assetId 原始来源 UUID。
   * @param recoveredAssetId 第一次恢复出的逻辑资产 UUID，由调用者同一事务创建并验证。
   * @returns 来源记录；已有其他恢复身份时失败，不覆盖原有标记。
   */
  async markRecovered(assetId: string, recoveredAssetId: string) {
    return this.withAssetLock(assetId, async (db) => {
      const existing = await db
        .selectFrom('fork_iphone_upload_origin')
        .selectAll()
        .where('assetId', '=', assetId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (existing.recoveredAssetId && existing.recoveredAssetId !== recoveredAssetId)
        throw new Error('Upload origin already recovered');
      if (existing.recoveredAssetId) return existing;
      return db
        .updateTable('fork_iphone_upload_origin')
        .set({ recoveredAssetId })
        .where('assetId', '=', assetId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  /** @param sourceId 原始物理资产 UUID。@param checksum 被固定的完整 SHA-1。@returns 已验证不可变副本的记录，不读取文件。 */
  getSnapshot(sourceId: string, checksum: Buffer) {
    return this.db
      .selectFrom('fork_iphone_source_snapshot')
      .selectAll()
      .where('sourceId', '=', sourceId)
      .where('checksum', '=', checksum)
      .executeTakeFirst();
  }

  /**
   * 记录专用工具已经完成并验证的不可变物理副本；原有键不能指向另一份文件。
   * @param input 同一归属来源的完整 SHA-1、来源路径和快照文件签名。
   * @returns 新建或幂等复用记录；此方法不创建、覆盖或删除任何文件。
   */
  async recordSnapshot(input: IphoneSourceSnapshotInput) {
    if (input.checksum.length !== 20 || !isAbsolute(input.path) || !input.signature)
      throw new Error('Invalid source snapshot evidence');
    return this.withAssetLock(input.sourceId, async (db, asset) => {
      if (
        asset.ownerId !== input.ownerId ||
        asset.libraryId !== input.libraryId ||
        asset.backupChecksum ||
        asset.deletedAt ||
        asset.isOffline ||
        asset.originalPath !== input.sourcePath ||
        !asset.contentChecksum?.equals(input.checksum)
      )
        throw new Error('Source snapshot asset changed');
      const existing = await db
        .selectFrom('fork_iphone_source_snapshot')
        .selectAll()
        .where('sourceId', '=', input.sourceId)
        .where('checksum', '=', input.checksum)
        .executeTakeFirst();
      if (existing) {
        if (existing.path !== input.path) throw new Error('Conflicting source snapshot');
        if (existing.signature === input.signature) return existing;
        // 同一完整内容可能在回退时重新建成新 inode；只刷新已由专用工具完整校验的签名，不改变身份或路径。
        return db
          .updateTable('fork_iphone_source_snapshot')
          .set({ signature: input.signature })
          .where('sourceId', '=', input.sourceId)
          .where('checksum', '=', input.checksum)
          .where('path', '=', input.path)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return db
        .insertInto('fork_iphone_source_snapshot')
        .values({ sourceId: input.sourceId, checksum: input.checksum, path: input.path, signature: input.signature })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * 检查快照路径和下载键是否仍被使用，包括已离线或软删除但可能恢复的资产。
   * @param sourceId 拟清理自有快照的资产 UUID。
   * @param checksum 拟清理的完整 SHA-1，不是物理来源当前摘要。
   * @param snapshotPath 精确私有文件路径；不进行目录范围查询。
   * @returns 其他快照行共享路径或任何资产仍选择该文件时为 true；不读取或删除文件。
   */
  async hasSnapshotConsumers(sourceId: string, checksum: Buffer, snapshotPath: string): Promise<boolean> {
    // 各资产分支分别使用来源、主键和原路径索引，避免 coalesce/跨列 OR 在每次清理时扫描整库。
    const used = await this.db
      .selectFrom('fork_iphone_source_snapshot')
      .select('sourceId as id')
      .where('path', '=', snapshotPath)
      .where((eb) => eb.or([eb('sourceId', '!=', sourceId), eb('checksum', '!=', checksum)]))
      .unionAll(
        this.db
          .selectFrom('asset')
          .select('id')
          .where('backupSourceId', '=', sourceId)
          .where('contentChecksum', '=', checksum),
      )
      .unionAll(
        this.db
          .selectFrom('asset')
          .select('id')
          .where('id', '=', sourceId)
          .where('backupSourceId', 'is', null)
          .where('contentChecksum', '=', checksum),
      )
      .unionAll(this.db.selectFrom('asset').select('id').where('originalPath', '=', snapshotPath))
      .limit(1)
      .executeTakeFirst();
    return !!used;
  }

  /**
   * 检查旧清理成功任务是否仍有当前可信上传的精确自有底稿，供有界能力升级补查。
   * @param assetId 已经建立引用的上传版本 UUID。
   * @param libraryId 当前明确配置的目标库；同库所有者必须仍与版本一致。
   * @returns 仅精确来源路径、完整摘要和自有快照键全部相符时为 true；不读取文件或授权删除。
   */
  async hasRedundantUploadSnapshot(assetId: string, libraryId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('asset')
      .innerJoin('library', 'library.id', 'asset.libraryId')
      .innerJoin('fork_iphone_upload_origin as origin', (join) =>
        join
          .onRef('origin.assetId', '=', 'asset.id')
          .onRef('origin.originalPath', '=', 'asset.backupOriginalPath')
          .onRef('origin.checksum', '=', 'asset.backupChecksum'),
      )
      .innerJoin('fork_iphone_source_snapshot as own', (join) =>
        join.onRef('own.sourceId', '=', 'asset.id').onRef('own.checksum', '=', 'asset.backupChecksum'),
      )
      .select('asset.id')
      .where('asset.id', '=', assetId)
      .where('asset.libraryId', '=', libraryId)
      .whereRef('asset.ownerId', '=', 'library.ownerId')
      .where('asset.isExternal', '=', true)
      .where('asset.backupSourceId', 'is not', null)
      .whereRef('asset.backupSourceId', '!=', 'asset.id')
      .where('asset.isOffline', '=', false)
      .where('asset.deletedAt', 'is', null)
      .where('library.deletedAt', 'is', null)
      .executeTakeFirst();
    return !!row;
  }

  /**
   * 删除已由业务层验证并移除文件的冗余上传自有记录；不能用于普通来源或任意历史快照。
   * @param input 调用者持有全局发布锁和来源→版本行锁时检查的精确快照证据。
   * @returns 该记录已删除；来源证明或记录发生变化时抛错，使外层事务回滚并可重试。
   */
  async deleteRedundantUploadSnapshot(input: IphoneRedundantSnapshotInput): Promise<void> {
    if (!this.db.isTransaction) throw new Error('Snapshot cleanup requires the reference transaction');
    await this.withAssetLock(input.assetId, async (db, asset) => {
      const origin = await this.getUpload(asset.id);
      if (
        !asset.backupSourceId ||
        asset.backupSourceId === asset.id ||
        !asset.backupChecksum?.equals(input.checksum) ||
        !origin ||
        origin.originalPath !== asset.backupOriginalPath ||
        !origin.checksum.equals(input.checksum)
      ) {
        throw new Error('Redundant upload snapshot identity changed');
      }
      const removed = await db
        .deleteFrom('fork_iphone_source_snapshot')
        .where('sourceId', '=', input.assetId)
        .where('checksum', '=', input.checksum)
        .where('path', '=', input.path)
        .where('signature', '=', input.signature)
        .executeTakeFirst();
      if (removed.numDeletedRows !== 1n) throw new Error('Redundant upload snapshot changed before cleanup');
    });
  }

  /** @param sourceId 原始来源 UUID。@returns 该来源仍保留的不可变版本，供明确的恢复与审计工具查看。 */
  listSnapshots(sourceId: string) {
    return this.db
      .selectFrom('fork_iphone_source_snapshot')
      .selectAll()
      .where('sourceId', '=', sourceId)
      .orderBy('createdAt')
      .execute();
  }

  /**
   * 形成同归属的独立 JPEG/PNG/HEIC 外部来源范围，明确排除历史暂存文件。
   * @param ownerId 已鉴权用户。
   * @param libraryId 配置图库。
   * @param historicalRoot 已解析的历史暂存绝对路径；SQL 使用前缀函数避免 LIKE 通配符歧义。
   * @returns 未执行的来源查询，供两个有界巡检方法共用。
   */
  private sources(ownerId: string, libraryId: string, historicalRoot: string) {
    if (!isAbsolute(historicalRoot)) throw new Error('Historical root must be absolute');
    const prefix = `${resolve(historicalRoot).replace(/\/$/, '')}/`;
    return this.db
      .selectFrom('asset')
      .innerJoin('library', 'library.id', 'asset.libraryId')
      .leftJoin('fork_iphone_image_fingerprint as fingerprint', 'fingerprint.assetId', 'asset.id')
      .select(['asset.id', 'asset.originalPath', 'asset.updateId', 'asset.contentChecksum'])
      .select(['fingerprint.signature as cachedSignature', 'fingerprint.fileChecksum as cachedChecksum'])
      .where('asset.ownerId', '=', ownerId)
      .where('asset.libraryId', '=', libraryId)
      .whereRef('library.ownerId', '=', 'asset.ownerId')
      .where('library.deletedAt', 'is', null)
      .where('asset.deletedAt', 'is', null)
      .where('asset.isOffline', '=', false)
      .where('asset.backupChecksum', 'is', null)
      .where('asset.isExternal', '=', true)
      .where('asset.type', '=', AssetType.Image)
      .where(sql<boolean>`NOT starts_with(asset."originalPath", ${prefix})`)
      .where(sql<boolean>`asset."originalPath" ~* '[.](jpe?g|png|heic|heif)$'`);
  }

  /**
   * 对尚无索引或已改变完整文件哈希的来源做有界分页，不按时间或标签过滤照片本体。
   * @param ownerId 已鉴权用户。@param libraryId 配置图库。@param historicalRoot 历史暂存绝对路径。
   * @param limit 本批 1..1000 条。@param after 上一页来源 ID，省略时从头开始。
   * @returns 待检查的乐观快照；格式不支持、读取错误由调用者明确处理。
   */
  indexingCandidates(ownerId: string, libraryId: string, historicalRoot: string, limit = 100, after?: string) {
    this.requireLimit(limit, 1000);
    return this.sources(ownerId, libraryId, historicalRoot)
      .where('asset.contentChecksum', 'is not', null)
      .where((eb) =>
        eb.or([
          eb('fingerprint.assetId', 'is', null),
          eb('fingerprint.fileChecksum', '!=', eb.ref('asset.contentChecksum')),
        ]),
      )
      .$if(!!after, (query) => query.where('asset.id', '>', after!))
      .orderBy('asset.id')
      .limit(limit)
      .execute();
  }

  /**
   * 巡检已有版本依赖或可信上传来源，避免每轮对全部 NAS 原片逐个 stat。
   * @param ownerId 已鉴权用户。@param libraryId 配置图库。@param historicalRoot 历史暂存绝对路径。
   * @param limit 本批 1..1000 条。@param after 上一页来源 ID。
   * @returns 包含已缓存签名的有界来源页；离线版本仍可依赖在线源恢复，但已删除版本不复活。
   */
  sourceCandidates(ownerId: string, libraryId: string, historicalRoot: string, limit = 100, after?: string) {
    this.requireLimit(limit, 1000);
    return this.sources(ownerId, libraryId, historicalRoot)
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('fork_iphone_upload_origin')
              .select('assetId')
              .whereRef('fork_iphone_upload_origin.assetId', '=', 'asset.id'),
          ),
          eb.exists(
            eb
              .selectFrom('asset as version')
              .select('version.id')
              .whereRef('version.backupSourceId', '=', 'asset.id')
              .where('version.deletedAt', 'is', null),
          ),
        ]),
      )
      .$if(!!after, (query) => query.where('asset.id', '>', after!))
      .orderBy('asset.id')
      .limit(limit)
      .execute();
  }

  /** @param limit 请求数量。@param maximum 当前操作允许的上限。拒绝零、非整数或无界批次。 */
  private requireLimit(limit: number, maximum: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error('Invalid image candidate limit');
  }
}
