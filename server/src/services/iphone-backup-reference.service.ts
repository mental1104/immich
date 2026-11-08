import { Kysely, Selectable, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { BigIntStats, constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AssetFileType, DatabaseLock, SyncEntityType } from 'src/enum.js';
import {
  IphoneBackupImageRepository,
  IphoneRedundantSnapshotInput,
} from 'src/repositories/iphone-backup-image.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import {
  IphoneBackupImage,
  UnsupportedIphoneBackupImageError,
  createIphoneBackupRecovery,
  readIphoneBackupImage,
  restoreIphoneBackupImage,
} from 'src/utils/iphone-backup-image.js';
import { createIphoneBackupSnapshot, readIphoneBackupSnapshot } from 'src/utils/iphone-backup-snapshot.js';
import { getIphoneBackupConfig, isWithinDirectory } from 'src/utils/iphone-backup.js';
import { fromAck } from 'src/utils/sync.js';

/** 只读计划；所有路径和哈希均来自服务器，应用前仍重新读取文件与数据库。 */
export interface IphoneBackupReferencePlan {
  versionId: string;
  sourceId: string;
  stagedPath: string;
  sourcePath: string;
  versionChecksum: string;
  sourceChecksum: string;
  image: string;
  metadata: string;
}

/** 批量检查不把未匹配、格式不支持或读取错误当成成功。 */
export interface IphoneBackupReferenceAssessment {
  id: string;
  status: 'matched' | 'unmatched' | 'unsupported' | 'conflict' | 'unsafe';
  plan?: IphoneBackupReferencePlan;
  reason?: string;
}

type ReferenceAsset = Selectable<AssetTable>;

/** 显式备份库的实际归属和只读检索范围，不包含其他用户或库。 */
interface ReferenceScope {
  libraryId: string;
  ownerId: string;
  historicalRoot: string;
  root: string;
  imports: string[];
}

/**
 * 为已上传的 JPEG/PNG 建立可恢复的物理原片引用；逻辑资产、原有视频关联及手机版本哈希保留。
 * 管理工具和显式启用的后台协调器共用校验；清理始终要求真实手机同步确认。
 */
export class IphoneBackupReferenceService {
  /** @param db 当前实例数据库。@param metadata 严格只读的元数据访问器。 */
  constructor(
    private readonly db: Kysely<DB>,
    private readonly metadata: Pick<MetadataRepository, 'readBackupTags'>,
  ) {}

  /** @returns 已校验的目标库和真实暂存根目录；未启用、缺失或归属不合法时拒绝工作。 */
  private async scope(): Promise<ReferenceScope> {
    const config = getIphoneBackupConfig();
    if (!config?.historicalRoot) {
      throw new Error('Historical backup staging must be configured');
    }
    const library = await this.db
      .selectFrom('library')
      .selectAll()
      .where('id', '=', config.libraryId)
      .executeTakeFirstOrThrow();
    if (library.deletedAt) {
      throw new Error('Backup library is deleted');
    }
    const historicalRoot = await realpath(config.historicalRoot);
    const root = await realpath(config.root);
    const imports = await Promise.all(library.importPaths.map((folder) => realpath(folder)));
    if (
      isWithinDirectory(root, historicalRoot) ||
      isWithinDirectory(historicalRoot, root) ||
      imports.every((folder) => !isWithinDirectory(folder, historicalRoot))
    ) {
      throw new Error('Invalid historical backup root');
    }
    return { libraryId: library.id, ownerId: library.ownerId, historicalRoot, root, imports };
  }

  /**
   * 只允许历史暂存文件或有服务端上传凭据的常规文件成为可清理版本。
   * @param version 当前资产；不信任公开可写的 asset_metadata 作为来源证明。
   * @param filename 上传时路径或 backupOriginalPath。
   * @param checksum 上传原文件的完整 SHA-1。
   * @param scope 已验证的用户、图库及两类根目录。
   * @param db 当前事务连接；未开启事务的只读预检默认使用实例连接。
   * @returns 是否有严格路径和内容来源证明；既有 NAS 原片不能被误判为上传副本。
   */
  private async isUploadPath(
    version: ReferenceAsset,
    filename: string,
    checksum: Buffer,
    scope: ReferenceScope,
    db: Kysely<DB> = this.db,
  ): Promise<boolean> {
    if (isWithinDirectory(scope.historicalRoot, filename)) return true;
    if (!isWithinDirectory(scope.root, filename)) return false;
    const origin = await new IphoneBackupImageRepository(db).getUpload(version.id);
    return !!origin && origin.originalPath === filename && origin.checksum.equals(checksum);
  }

  /**
   * 构造同用户同库的独立在线原片查询，排除暂存版本，不依赖名称或是否处于已有堆叠。
   * @param db 当前连接或只读事务，查询不会更新资产。
   * @param version 需要匹配的已上传资产，仅同类型参与候选。
   * @param scope 已校验的归属和暂存根目录。
   * @returns 尚未执行且仍保留具体表类型的查询。
   */
  private sourceQuery(db: Kysely<DB>, version: ReferenceAsset, scope: ReferenceScope) {
    return db
      .selectFrom('asset')
      .selectAll('asset')
      .where('asset.ownerId', '=', scope.ownerId)
      .where('asset.libraryId', '=', scope.libraryId)
      .where('asset.backupChecksum', 'is', null)
      .where('asset.isOffline', '=', false)
      .where('asset.deletedAt', 'is', null)
      .where('asset.contentChecksum', 'is not', null)
      .where('asset.type', '=', version.type)
      .where('asset.id', '!=', version.id)
      .where('asset.originalPath', 'not like', `${scope.historicalRoot}/%`);
  }

  /**
   * 先查记录时间附近的原片；未命中才复用既有 CLIP 索引，所有候选仍须由实际字节验证。
   * @param version 已上传资产；缺少向量时仅执行时间候选，不触发模型任务。
   * @param scope 限定用户、库和真实目录。
   * @returns 顺序输出去重候选；时间候选命中后调用者结束迭代，不执行视觉检索。
   */
  private async *sourceCandidates(
    version: ReferenceAsset,
    scope: ReferenceScope,
    fingerprint?: string,
  ): AsyncGenerator<ReferenceAsset> {
    const seen = new Set<string>();
    // 主体指纹是第一查找键，不要求文件名、拍摄时间、GPS 或标签相同；候选仍须实文件复核。
    if (fingerprint) {
      const indexed = await new IphoneBackupImageRepository(this.db).findByImage(
        scope.ownerId,
        scope.libraryId,
        fingerprint,
        version.id,
      );
      for (const row of indexed) {
        if (isWithinDirectory(scope.historicalRoot, row.originalPath)) {
          continue;
        }

        seen.add(row.id);
        yield row;
      }
    }
    const nearby = await this.sourceQuery(this.db, version, scope)
      .where('asset.fileCreatedAt', '>=', new Date(new Date(version.fileCreatedAt).getTime() - 2000))
      .where('asset.fileCreatedAt', '<=', new Date(new Date(version.fileCreatedAt).getTime() + 2000))
      .orderBy('asset.createdAt')
      .orderBy('asset.id')
      .limit(64)
      .execute();
    for (const candidate of nearby) {
      if (seen.has(candidate.id)) {
        continue;
      }

      seen.add(candidate.id);
      yield candidate;
    }
    const feature = await this.db
      .selectFrom('smart_search')
      .select('embedding')
      .where('assetId', '=', version.id)
      .executeTakeFirst();
    if (!feature) return;
    const visual = await this.db.transaction().execute(async (tx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      await sql`SET LOCAL statement_timeout = '15s'`.execute(tx);
      // 复用上游的距离算子和现有索引；四个分区及 12 个候选限制只读回退的工作量。
      await sql`SET LOCAL vchordrq.probes = 4`.execute(tx);
      return this.sourceQuery(tx, version, scope)
        .innerJoin('smart_search', 'smart_search.assetId', 'asset.id')
        .select(sql<number>`smart_search.embedding <=> ${feature.embedding}::vector`.as('distance'))
        .orderBy('distance')
        .limit(12)
        .execute();
    });
    for (const candidate of visual) {
      if (candidate.distance <= 0.15 && !seen.has(candidate.id)) yield candidate;
    }
  }

  /**
   * 只检查一批暂存资产，顺序读取候选；时间仅缩小范围，编码图像必须一致。
   * 逻辑版本及其完整元数据分别保留，评分、GPS 等差异不需要被覆盖或忽略。
   * @param limit 每批上限，1 到 2000。
   * @param after 可选的上一批最后资产 ID，用于恢复批量进度。
   * @returns 匹配计划和未匹配状态；不更新资产，不清理任何文件。
   */
  assess(limit = 100, after?: string): Promise<IphoneBackupReferenceAssessment[]> {
    return this.assessVersions(limit, after);
  }

  /**
   * 只检查队列指定的一个暂存资产，复用批处理的全部归属、文件和恢复保护。
   * @param versionId 服务器提供的资产 UUID，不接受路径或客户端提供的匹配结论。
   * @returns 已处理或已不在暂存范围时为 undefined；其他结果明确保留未匹配及异常状态。
   */
  async assessAsset(versionId: string): Promise<IphoneBackupReferenceAssessment | undefined> {
    const assessments = await this.assessVersions(1, undefined, versionId);
    return assessments[0];
  }

  /**
   * 顺序验证有界资产集；批处理和逐资产任务使用同一条校验路径。
   * @param limit 最多读取的资产数，范围 1..2000。
   * @param after 批处理分页下界，省略时从头开始。
   * @param versionId 可选的精确资产约束，用于后台任务，不能扩展既定用户或图库范围。
   * @returns 每个候选的真实检查结果；不创建关联、不清理文件。
   */
  private async assessVersions(
    limit: number,
    after?: string,
    versionId?: string,
  ): Promise<IphoneBackupReferenceAssessment[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
      throw new Error('Reference batch limit must be between 1 and 2000');
    }
    const scope = await this.scope();
    const versions = await this.db
      .selectFrom('asset')
      .selectAll()
      .where('ownerId', '=', scope.ownerId)
      .where('libraryId', '=', scope.libraryId)
      .where('backupChecksum', 'is', null)
      .where('isOffline', '=', false)
      .where('deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('originalPath', 'like', `${scope.historicalRoot}/%`),
          eb.and([
            eb('originalPath', 'like', `${scope.root}/%`),
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
      .$if(!!after, (query) => query.where('id', '>', after!))
      .$if(!!versionId, (query) => query.where('id', '=', versionId!))
      .orderBy('id')
      .limit(limit)
      .execute();
    const results: IphoneBackupReferenceAssessment[] = [];
    for (const version of versions) {
      try {
        if (!/\.(?:jpe?g|png|heic|heif)$/i.test(version.originalPath) || !version.contentChecksum) {
          results.push({ id: version.id, status: 'unsupported' });
          continue;
        }
        if (!(await this.isUploadPath(version, await realpath(version.originalPath), version.contentChecksum, scope))) {
          throw new Error('Staged file escapes configured root');
        }
        const fresh = await readIphoneBackupImage(version.originalPath, this.metadata);
        if (fresh.checksum !== version.contentChecksum.toString('hex')) {
          throw new Error('Staged checksum changed');
        }
        let plan: IphoneBackupReferencePlan | undefined;
        let conflict = false;
        for await (const source of this.sourceCandidates(version, scope, fresh.image)) {
          if (
            isWithinDirectory(scope.historicalRoot, source.originalPath) ||
            !/\.(?:jpe?g|png|heic|heif)$/i.test(source.originalPath)
          ) {
            continue;
          }
          if (scope.imports.every((folder) => !isWithinDirectory(folder, source.originalPath))) {
            continue;
          }
          let existing: IphoneBackupImage;
          try {
            existing = await readIphoneBackupImage(source.originalPath, this.metadata);
          } catch (error) {
            // 不同实际格式不能共享 JPEG/PNG 编码；仅排除明确未支持格式，I/O 和校验错误仍必须停止。
            if (error instanceof UnsupportedIphoneBackupImageError) continue;
            throw error;
          }
          if (existing.checksum !== source.contentChecksum?.toString('hex') || existing.image !== fresh.image) {
            continue;
          }
          if (version.stackId && version.stackId !== source.stackId) {
            conflict = true;
            continue;
          }
          const sidecar = await this.db
            .selectFrom('asset_file')
            .select('id')
            .where('assetId', 'in', [version.id, source.id])
            .where('type', '=', AssetFileType.Sidecar)
            .executeTakeFirst();
          if (sidecar) {
            conflict = true;
            continue;
          }
          plan = {
            versionId: version.id,
            sourceId: source.id,
            stagedPath: version.originalPath,
            sourcePath: source.originalPath,
            versionChecksum: fresh.checksum,
            sourceChecksum: existing.checksum,
            image: fresh.image,
            metadata: fresh.metadata,
          };
          break;
        }
        results.push({ id: version.id, status: plan ? 'matched' : conflict ? 'conflict' : 'unmatched', plan });
      } catch (error) {
        // 任一候选读取异常就保留该版本，不以跳过异常换取清理数量。
        results.push({
          id: version.id,
          status: error instanceof UnsupportedIphoneBackupImageError ? 'unsupported' : 'unsafe',
          reason: error instanceof Error ? error.message : 'Unknown reference error',
        });
      }
    }
    return results;
  }

  /**
   * 在锁外取得严格文件证据，再在发布/扫描共用锁内复核并切换为共用原片。
   * ExifTool 可能等待共享进程池，不能让这段等待占用所有上传的发布锁；暂存文件仍保留到手机确认。
   * @param plan 来自只读检查的具体计划，不能代替本次重新校验。
   * @returns 稳定的逻辑版本 ID 和同步游标；重复调用不创建新资产。
   */
  async prepare(plan: IphoneBackupReferencePlan): Promise<{ id: string; updateId: string }> {
    const scope = await this.scope();
    const evidence = await this.prepareEvidence(plan, scope);
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(${DatabaseLock.ForkIphoneBackup})`.execute(tx);
      // 先锁物理原片再锁版本，与原片状态传播顺序一致，避免父子行互相等待。
      const source = await tx
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', plan.sourceId)
        .forUpdate()
        .executeTakeFirst();
      const version = await tx
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', plan.versionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !version ||
        !source ||
        version.id === source.id ||
        [version, source].some(
          (row) => row.ownerId !== scope.ownerId || row.libraryId !== scope.libraryId || row.isOffline || row.deletedAt,
        )
      ) {
        throw new Error('Backup reference ownership or availability changed');
      }
      if (version.backupChecksum) {
        if (
          version.backupSourceId !== source.id ||
          version.backupChecksum.toString('hex') !== plan.versionChecksum ||
          version.contentChecksum?.toString('hex') !== plan.sourceChecksum
        ) {
          throw new Error('Conflicting backup reference');
        }
        return { id: version.id, updateId: version.updateId };
      }
      if (
        source.backupChecksum ||
        source.originalPath !== plan.sourcePath ||
        version.originalPath !== plan.stagedPath ||
        !(await this.isUploadPath(version, plan.stagedPath, Buffer.from(plan.versionChecksum, 'hex'), scope, tx)) ||
        isWithinDirectory(scope.historicalRoot, plan.sourcePath)
      ) {
        throw new Error('Backup reference paths changed');
      }
      await this.validateReferenceState(plan, version, source, tx);
      // 锁外已关联但入锁前被恢复的记录没有本次文件证据，必须重试，不能沿用旧计划猜测字节。
      if (!evidence) throw new Error('Backup evidence became stale before reference commit');
      const phoneBytes = await this.readPreparedImage(plan.stagedPath, evidence[0]);
      const sourceBytes = await this.readPreparedImage(plan.sourcePath, evidence[1]);
      const backupMetadata = createIphoneBackupRecovery(phoneBytes, sourceBytes);
      if (!restoreIphoneBackupImage(sourceBytes, backupMetadata).equals(phoneBytes)) {
        throw new Error('Backup recovery verification failed');
      }
      // 先持久保护独立编码底稿，避免 NAS 软件以后覆盖图像本体时失去手机版本。
      const snapshotRoot = process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT;
      if (!snapshotRoot) throw new Error('Immutable backup snapshot root is required');
      const snapshot = await createIphoneBackupSnapshot({
        root: snapshotRoot,
        sourcePath: source.originalPath,
        sourceId: source.id,
        checksum: plan.sourceChecksum,
      });
      await new IphoneBackupImageRepository(tx).recordSnapshot({
        sourceId: source.id,
        ownerId: scope.ownerId,
        libraryId: scope.libraryId,
        sourcePath: source.originalPath,
        checksum: Buffer.from(plan.sourceChecksum, 'hex'),
        path: snapshot.path,
        signature: snapshot.signature,
      });
      if (version.stackId && version.stackId !== source.stackId) {
        throw new Error('Backup reference stack conflict');
      }
      let stackId = source.stackId;
      if (!stackId) {
        const stack = await tx
          .insertInto('stack')
          .values({ ownerId: scope.ownerId, primaryAssetId: source.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        stackId = stack.id;
        await tx.updateTable('asset').set({ stackId }).where('id', '=', source.id).execute();
      }
      // 保留两个独立客户端身份；实际原片内容指纹与手机版本指纹不再混为同一字段。
      const updated = await tx
        .updateTable('asset')
        .set({
          backupChecksum: Buffer.from(plan.versionChecksum, 'hex'),
          backupSourceId: source.id,
          backupOriginalPath: plan.stagedPath,
          backupMetadata,
          contentChecksum: Buffer.from(plan.sourceChecksum, 'hex'),
          originalPath: source.originalPath,
          stackId,
        })
        .where('id', '=', version.id)
        .returning(['id', 'updateId', 'clientChecksum'])
        .executeTakeFirstOrThrow();
      if (version.clientChecksum && !updated.clientChecksum?.equals(version.clientChecksum)) {
        throw new Error('Backup matching identity changed');
      }
      return { id: updated.id, updateId: updated.updateId };
    });
  }

  /**
   * 不持发布锁地取得完整图像、渲染配置和元数据证据；只允许当前归属及路径的服务器资产。
   * @param plan 本次计划，校验后仍须在事务内重新核实数据库状态和实际字节。
   * @param scope 已核实的用户、图库和暂存范围。
   * @returns 两份稳定文件的严格证据；已关联时不读取可能已清理的暂存文件，由锁内幂等分支裁决。
   */
  private async prepareEvidence(
    plan: IphoneBackupReferencePlan,
    scope: ReferenceScope,
  ): Promise<[IphoneBackupImage, IphoneBackupImage] | undefined> {
    const version = await this.db.selectFrom('asset').selectAll().where('id', '=', plan.versionId).executeTakeFirst();
    const source = await this.db.selectFrom('asset').selectAll().where('id', '=', plan.sourceId).executeTakeFirst();
    if (
      !version ||
      !source ||
      version.id === source.id ||
      [version, source].some(
        (row) => row.ownerId !== scope.ownerId || row.libraryId !== scope.libraryId || row.isOffline || row.deletedAt,
      )
    ) {
      throw new Error('Backup reference ownership or availability changed');
    }
    // 重入时暂存文件可以已被手机确认后的清理删除；真正的冲突/幂等检查仍在行锁内进行。
    if (version.backupChecksum) return;
    if (
      source.backupChecksum ||
      source.originalPath !== plan.sourcePath ||
      version.originalPath !== plan.stagedPath ||
      !(await this.isUploadPath(version, plan.stagedPath, Buffer.from(plan.versionChecksum, 'hex'), scope)) ||
      isWithinDirectory(scope.historicalRoot, plan.sourcePath)
    ) {
      throw new Error('Backup reference paths changed');
    }
    return this.validateImages(plan, version, source, this.db);
  }

  /**
   * 用固定上限读取仍与锁外严格证据一致的文件，不在发布锁内再次等待 ExifTool。
   * @param filename 已由当前锁定资产确认的绝对路径。
   * @param evidence 实际取得的完整摘要和 inode/尺寸/纳秒时间签名，不接受计划中的自报证据。
   * @returns 有界原始字节；路径替换、文件增长、原地改写或摘要变化均拒绝提交。
   */
  private async readPreparedImage(
    filename: string,
    evidence: Pick<IphoneBackupImage, 'signature' | 'checksum'>,
  ): Promise<Buffer> {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.size > 64n * 1024n * 1024n ||
        this.preparedSignature(before) !== evidence.signature ||
        (await realpath(filename)) !== filename
      ) {
        throw new Error('Backup bytes changed before reference commit');
      }
      // 分配只取证据中的实际尺寸，额外探测一个字节；增长文件不能令 readFile 无界分配。
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) throw new Error('Backup bytes changed before reference commit');
        offset += read.bytesRead;
      }
      const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
      if (
        extra.bytesRead > 0 ||
        this.preparedSignature(await file.stat({ bigint: true })) !== evidence.signature ||
        this.preparedSignature(await lstat(filename, { bigint: true })) !== evidence.signature ||
        (await realpath(filename)) !== filename ||
        createHash('sha1').update(bytes).digest('hex') !== evidence.checksum
      ) {
        throw new Error('Backup bytes changed before reference commit');
      }
      return bytes;
    } finally {
      await file.close();
    }
  }

  /** @param stat 文件描述符或路径的实际状态。@returns 与严格锁外读取相同的稳定签名。 */
  private preparedSignature(stat: BigIntStats): string {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  /**
   * 手机已确认新资产记录且两份文件重新校验后，才移除指定暂存文件。
   * @param versionId 已建立持久关联的逻辑版本 UUID。
   * @param sessionId 属于同一用户的手机会话；必须完成新的资产同步和同步结束确认。
   * @returns cleaned 表示本次确实删除文件，absent 表示重复执行时文件已不存在。
   */
  async cleanup(versionId: string, sessionId: string): Promise<'cleaned' | 'absent'> {
    const scope = await this.scope();
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(${DatabaseLock.ForkIphoneBackup})`.execute(tx);
      const initial = await tx
        .selectFrom('asset')
        .select('backupSourceId')
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow();
      if (!initial.backupSourceId) {
        throw new Error('Missing backup source');
      }
      const source = await tx
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', initial.backupSourceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const version = await tx
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', versionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const session = await tx
        .selectFrom('session')
        .select(['userId', 'isPendingSyncReset'])
        .where('id', '=', sessionId)
        .executeTakeFirstOrThrow();
      if (
        version.ownerId !== scope.ownerId ||
        version.libraryId !== scope.libraryId ||
        session.userId !== scope.ownerId ||
        session.isPendingSyncReset ||
        !version.backupChecksum ||
        version.backupSourceId !== source.id ||
        !version.backupOriginalPath ||
        !version.contentChecksum ||
        !version.backupMetadata ||
        version.isOffline ||
        version.deletedAt
      ) {
        throw new Error('Backup reference is not ready for cleanup');
      }
      const checkpoints = await tx
        .selectFrom('session_sync_checkpoint')
        .selectAll()
        .where('sessionId', '=', sessionId)
        .where('type', 'in', [SyncEntityType.AssetV2, SyncEntityType.SyncCompleteV1])
        .where('updatedAt', '>=', version.updatedAt)
        .execute();
      const assetAck = checkpoints.find((row) => row.type === SyncEntityType.AssetV2);
      const complete = checkpoints.some((row) => row.type === SyncEntityType.SyncCompleteV1);
      const ack = assetAck && fromAck(assetAck.ack);
      if (
        !ack ||
        !complete ||
        ack.type !== SyncEntityType.AssetV2 ||
        !/^[a-f\d-]{36}$/.test(ack.updateId ?? '') ||
        ack.updateId < version.updateId
      ) {
        throw new Error('Phone must acknowledge the backup reference before cleanup');
      }
      if (
        !(await this.isUploadPath(version, version.backupOriginalPath, version.backupChecksum, scope, tx)) ||
        isWithinDirectory(scope.historicalRoot, version.originalPath)
      ) {
        throw new Error('Unsafe backup cleanup path');
      }
      if (
        source.ownerId !== scope.ownerId ||
        source.libraryId !== scope.libraryId ||
        source.backupChecksum ||
        source.backupSourceId ||
        source.id === version.id ||
        source.deletedAt ||
        source.isOffline
      ) {
        throw new Error('Backup source ownership or availability changed');
      }
      // 暂存文件已删不代表底稿可删；重入仍须重新完成手机确认和 B→A 的完整恢复证明。
      const stagedSignature = await this.fileSignatureOrAbsent(version.backupOriginalPath);
      const snapshot = await new IphoneBackupImageRepository(tx).getSnapshot(source.id, version.contentChecksum);
      const snapshotRoot = process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT;
      if (!snapshot || !snapshotRoot) throw new Error('Verified immutable backup snapshot is required');
      this.assertSnapshotIdentity(snapshot.path, snapshotRoot, source.id, version.contentChecksum);
      const pinnedBytes = await readIphoneBackupSnapshot({
        path: snapshot.path,
        root: snapshotRoot,
        checksum: version.contentChecksum.toString('hex'),
      });
      const restored = restoreIphoneBackupImage(pinnedBytes, version.backupMetadata);
      if (createHash('sha1').update(restored).digest('hex') !== version.backupChecksum.toString('hex')) {
        throw new Error('Backup recovery checksum mismatch');
      }
      if (stagedSignature) {
        const stagedBytes = await this.readPreparedImage(version.backupOriginalPath, {
          signature: stagedSignature,
          checksum: version.backupChecksum.toString('hex'),
        });
        if (!restored.equals(stagedBytes)) throw new Error('Staged original changed before cleanup');
      }
      // 仍有其他资产使用暂存路径时拒绝删除，保留人工或历史导入的独立引用。
      const used = await tx
        .selectFrom('asset')
        .select('id')
        .where('originalPath', '=', version.backupOriginalPath)
        .executeTakeFirst();
      if (used) {
        throw new Error('Staged file is still referenced by an asset');
      }
      const redundant = await this.redundantUploadSnapshot(version, source, snapshot.path, snapshotRoot, tx);
      if (stagedSignature !== (await this.fileSignatureOrAbsent(version.backupOriginalPath))) {
        throw new Error('Staged original changed before cleanup');
      }
      // 所有依赖和完整内容先验证，再执行不可回滚的文件删除；失败时保留精确数据库记录供重试。
      if (stagedSignature) {
        await unlink(version.backupOriginalPath);
        await this.syncDirectory(path.dirname(version.backupOriginalPath));
      }
      if (redundant) {
        const current = await this.fileSignatureOrAbsent(redundant.evidence.path);
        if (current !== redundant.fileSignature) throw new Error('Redundant upload snapshot changed before cleanup');
        if (current) {
          await unlink(redundant.evidence.path);
          await this.syncDirectory(path.dirname(redundant.evidence.path));
        }
        await new IphoneBackupImageRepository(tx).deleteRedundantUploadSnapshot(redundant.evidence);
      }
      return stagedSignature ? 'cleaned' : 'absent';
    });
  }

  /** @param filename 快照规范路径。@param root 私有根。@param sourceId 精确所属资产。@param checksum 完整 SHA-1。@returns 路径严格绑定指定键，其他 UUID 或版本均拒绝。 */
  private assertSnapshotIdentity(filename: string, root: string, sourceId: string, checksum: Buffer): void {
    const digest = checksum.toString('hex');
    if (['jpg', 'png', 'heic'].every((suffix) => filename !== path.join(root, sourceId, `${digest}.${suffix}`))) {
      throw new Error('Backup snapshot path does not match its identity');
    }
  }

  /**
   * 只选择当前可信上传引用的冗余自有底稿，不扩大为普通来源或历史版本的通用回收。
   * @param version 已锁定且可以从 pin 完整恢复的上传版本。
   * @param source 同用户同库的独立物理源。
   * @param pinnedPath 仍须保留的 B pin 路径。
   * @param root 已完成私有目录与实际文件验证的快照根。
   * @param tx 已持有发布锁及 B→A 行锁的事务。
   * @returns 精确删除证据及实际文件签名；未获得来源证明或无自有记录时不回收。
   */
  private async redundantUploadSnapshot(
    version: ReferenceAsset,
    source: ReferenceAsset,
    pinnedPath: string,
    root: string,
    tx: Kysely<DB>,
  ): Promise<{ evidence: IphoneRedundantSnapshotInput; fileSignature?: string } | undefined> {
    const repository = new IphoneBackupImageRepository(tx);
    const origin = await repository.getUpload(version.id);
    // 旧历史引用没有 upload_origin 时仍可清理 stage，但不能借此删除任何自有快照。
    if (
      !version.isExternal ||
      !source.isExternal ||
      !version.backupChecksum ||
      !origin ||
      origin.originalPath !== version.backupOriginalPath ||
      !origin.checksum.equals(version.backupChecksum)
    ) {
      return;
    }
    const own = await repository.getSnapshot(version.id, version.backupChecksum);
    if (!own) return;
    this.assertSnapshotIdentity(own.path, root, version.id, version.backupChecksum);
    if (own.path === pinnedPath || (await repository.hasSnapshotConsumers(version.id, own.checksum, own.path))) {
      throw new Error('Redundant upload snapshot is still referenced');
    }
    const fileSignature = await this.fileSignatureOrAbsent(own.path);
    if (fileSignature) {
      await readIphoneBackupSnapshot({ path: own.path, root, checksum: own.checksum.toString('hex') });
      if (fileSignature !== own.signature || fileSignature !== (await this.uploadSignature(own.path))) {
        throw new Error('Redundant upload snapshot changed before cleanup');
      }
    }
    return {
      evidence: { assetId: version.id, checksum: own.checksum, path: own.path, signature: own.signature },
      fileSignature,
    };
  }

  /** @param filename 已通过来源和范围验证的路径。@returns 稳定文件签名，真正不存在时为 undefined；悬空链接及父目录别名不是缺失文件。 */
  private async fileSignatureOrAbsent(filename: string): Promise<string | undefined> {
    try {
      return await this.uploadSignature(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // 缺失层级逐级上溯：不能把一个指向不存在目标的目录链接误当作可安全重入的 ENOENT。
    let parent = path.dirname(filename);
    while (true) {
      try {
        const directory = await lstat(parent);
        if (!directory.isDirectory() || (await realpath(parent)) !== parent) {
          throw new Error('Unsafe staged backup file');
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path.dirname(parent)) throw error;
        parent = path.dirname(parent);
      }
    }
  }

  /** @param directory 已验证目录。@returns 将删除的目录项持久化后，才允许提交快照记录删除。 */
  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** @param filename 已验证上传来源的规范路径。@returns 用于删除前复核的稳定签名；拒绝符号链接及父目录别名。 */
  private async uploadSignature(filename: string): Promise<string> {
    const stat = await lstat(filename, { bigint: true });
    if (!stat.isFile() || stat.size > 64n * 1024n * 1024n || (await realpath(filename)) !== filename) {
      throw new Error('Unsafe staged backup file');
    }
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  /**
   * 校验恢复路径是规范普通文件且仍保存完整原始字节，拒绝匹配内容的符号链接和父目录别名。
   * @param filename 已验证上传范围内的新发布或已有暂存路径。
   * @param expected 从不可变 pin 完整恢复且通过 SHA-1 验证的手机版本。
   * @returns 稳定文件签名，供提交前再次验证；文件不一致或路径异常时不撤销引用。
   */
  private async verifyRestoredUpload(filename: string, expected: Buffer): Promise<string> {
    const before = await this.uploadSignature(filename);
    const bytes = await this.readPreparedImage(filename, {
      signature: before,
      checksum: createHash('sha1').update(expected).digest('hex'),
    });
    if (!bytes.equals(expected) || before !== (await this.uploadSignature(filename))) {
      throw new Error('Restored upload changed before commit');
    }
    return before;
  }

  /**
   * 回退一个已经共用原片的版本：先无损恢复暂存文件，再撤销引用，不改动 NAS 原片。
   * @param versionId 本用户本目标库的逻辑版本 UUID。
   * @returns 已恢复或本来就不是引用版本；无法重建、路径异常或冲突时不撤销恢复配方。
   */
  async restore(versionId: string): Promise<'restored' | 'not-referenced'> {
    const scope = await this.scope();
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(${DatabaseLock.ForkIphoneBackup})`.execute(tx);
      // 回退也遵守物理源 B→版本 A 的锁序；源状态传播不能在文件证明期间改变归属。
      const initial = await tx
        .selectFrom('asset')
        .select('backupSourceId')
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow();
      const source = initial.backupSourceId
        ? await tx
            .selectFrom('asset')
            .selectAll()
            .where('id', '=', initial.backupSourceId)
            .forUpdate()
            .executeTakeFirst()
        : undefined;
      const version = await tx
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', versionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (version.ownerId !== scope.ownerId || version.libraryId !== scope.libraryId)
        throw new Error('Invalid backup restore owner');
      if (!version.backupChecksum) return 'not-referenced';
      if (
        !version.backupSourceId ||
        !version.backupMetadata ||
        !version.backupOriginalPath ||
        !(await this.isUploadPath(version, version.backupOriginalPath, version.backupChecksum, scope, tx)) ||
        isWithinDirectory(scope.historicalRoot, version.originalPath)
      )
        throw new Error('Unsafe backup restore path');
      if (
        !source ||
        source.id !== version.backupSourceId ||
        source.id === version.id ||
        source.ownerId !== scope.ownerId ||
        source.libraryId !== scope.libraryId
      )
        throw new Error('Backup restore source is unavailable');
      const snapshot =
        version.contentChecksum &&
        (await new IphoneBackupImageRepository(tx).getSnapshot(version.backupSourceId, version.contentChecksum));
      const snapshotRoot = process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT;
      if (!snapshotRoot) throw new Error('Immutable backup snapshot root is required');
      if (snapshot && version.contentChecksum)
        this.assertSnapshotIdentity(snapshot.path, snapshotRoot, source.id, version.contentChecksum);
      const sourceBytes =
        snapshot && snapshotRoot
          ? await readIphoneBackupSnapshot({
              path: snapshot.path,
              root: snapshotRoot,
              checksum: version.contentChecksum!.toString('hex'),
            })
          : await readFile(version.originalPath);
      const bytes = restoreIphoneBackupImage(sourceBytes, version.backupMetadata);
      if (createHash('sha1').update(bytes).digest('hex') !== version.backupChecksum.toString('hex'))
        throw new Error('Backup restore identity mismatch');
      const restoreRoot = isWithinDirectory(scope.historicalRoot, version.backupOriginalPath)
        ? scope.historicalRoot
        : scope.root;
      let parent = restoreRoot;
      for (const folder of path.relative(parent, path.dirname(version.backupOriginalPath)).split(path.sep)) {
        if (!folder) continue;
        const next = path.join(parent, folder);
        await mkdir(next, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        const directory = await lstat(next);
        if (!directory.isDirectory() || (await realpath(next)) !== next || !isWithinDirectory(restoreRoot, next)) {
          throw new Error('Unsafe backup restore directory');
        }
        parent = next;
      }
      const temporary = `${version.backupOriginalPath}.restore-${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        await link(temporary, version.backupOriginalPath).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
          await this.verifyRestoredUpload(version.backupOriginalPath!, bytes);
        });
      } finally {
        await unlink(temporary);
      }
      const directory = await open(parent, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const restoredSignature = await this.verifyRestoredUpload(version.backupOriginalPath, bytes);
      // 撤销引用前重新固定 A 的完整初始版本；GC 或先前回滚可能已移除这个自有文件。
      const ownSnapshot = await createIphoneBackupSnapshot({
        root: snapshotRoot,
        sourcePath: version.backupOriginalPath,
        sourceId: version.id,
        checksum: version.backupChecksum.toString('hex'),
      });
      if (restoredSignature !== (await this.uploadSignature(version.backupOriginalPath))) {
        throw new Error('Restored upload changed before commit');
      }
      await tx
        .updateTable('asset')
        .set({
          originalPath: version.backupOriginalPath,
          contentChecksum: version.backupChecksum,
          backupChecksum: null,
          backupSourceId: null,
          backupOriginalPath: null,
          backupMetadata: null,
          isOffline: false,
        })
        .where('id', '=', version.id)
        .execute();
      // recordSnapshot 只接受独立来源，故先在同一事务切回普通资产，再登记不可变基线。
      await new IphoneBackupImageRepository(tx).recordSnapshot({
        sourceId: version.id,
        ownerId: scope.ownerId,
        libraryId: scope.libraryId,
        sourcePath: version.backupOriginalPath,
        checksum: version.backupChecksum,
        path: ownSnapshot.path,
        signature: ownSnapshot.signature,
      });
      await tx
        .updateTable('asset_exif')
        .set({ fileSizeInByte: bytes.length })
        .where('assetId', '=', version.id)
        .execute();
      return 'restored';
    });
  }

  /**
   * 复核独立源、同归属及 Sidecar 条件；锁外证据不能代替提交事务中的当前数据库状态。
   * @param plan 本次关联的预期源路径及完整摘要。
   * @param version 当前锁定的手机版本记录。
   * @param source 当前锁定且不允许引用链的物理资产。
   * @param db 本次事务连接，避免在事务内另借连接或读取不同快照。
   * @returns 校验成功时完成；任一状态变化直接失败，不读取或删除文件。
   */
  private async validateReferenceState(
    plan: IphoneBackupReferencePlan,
    version: ReferenceAsset,
    source: ReferenceAsset,
    db: Kysely<DB>,
  ): Promise<void> {
    if (
      source.backupChecksum ||
      source.isOffline ||
      source.deletedAt ||
      source.ownerId !== version.ownerId ||
      source.libraryId !== version.libraryId ||
      source.originalPath !== plan.sourcePath ||
      source.contentChecksum?.toString('hex') !== plan.sourceChecksum
    ) {
      throw new Error('Backup source changed');
    }
    const sidecar = await db
      .selectFrom('asset_file')
      .select('id')
      .where('assetId', 'in', [version.id, source.id])
      .where('type', '=', AssetFileType.Sidecar)
      .executeTakeFirst();
    // 每个逻辑照片保留自己的 livePhotoVideoId；这里只共用静态编码，不移动、覆盖或删除视频。
    if (sidecar) {
      throw new Error('Backup reference has unsupported associated data');
    }
  }

  /**
   * 在发布锁外取得图像及元数据证明，保留 ICC/Adobe、PNG 与严格 HEIC 的全部原有校验。
   * @param plan 服务器计划，文件摘要、编码图像和手机版本元数据必须仍与之相符。
   * @param version 已先核实归属和上传路径的手机版本。
   * @param source 已先核实归属和路径的独立原片。
   * @param db 只读校验使用的数据库连接；提交前会在持锁事务内重做行状态校验。
   * @returns 只能绑定本次稳定原始文件的两份证据，失败不创建关联或删除文件。
   */
  private async validateImages(
    plan: IphoneBackupReferencePlan,
    version: ReferenceAsset,
    source: ReferenceAsset,
    db: Kysely<DB>,
  ): Promise<[IphoneBackupImage, IphoneBackupImage]> {
    await this.validateReferenceState(plan, version, source, db);
    const fresh = await readIphoneBackupImage(plan.stagedPath, this.metadata);
    const existing = await readIphoneBackupImage(plan.sourcePath, this.metadata);
    if (
      fresh.checksum !== plan.versionChecksum ||
      existing.checksum !== plan.sourceChecksum ||
      fresh.image !== existing.image ||
      (plan.image && fresh.image !== plan.image) ||
      (plan.metadata && fresh.metadata !== plan.metadata)
    ) {
      throw new Error('Backup files are not metadata-only equivalents');
    }
    return [fresh, existing];
  }
}
