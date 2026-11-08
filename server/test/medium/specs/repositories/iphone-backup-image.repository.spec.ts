import { schemaDiff, schemaFromCode, schemaFromDatabase } from '@immich/sql-tools';
import { Insertable, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetType, ChecksumAlgorithm } from 'src/enum.js';
import {
  IphoneBackupImageRepository,
  IphoneImageFingerprintInput,
  IphoneUploadOriginInput,
} from 'src/repositories/iphone-backup-image.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { immich_uuid_v7 } from 'src/schema/functions.js';
import { DB } from 'src/schema/index.js';
import { down } from 'src/schema/migrations/1793952000000-ForkIphoneImageFingerprints.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { LibraryService } from 'src/services/library.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** 验证持久候选和上传来源的数据库边界；不访问真实照片、部署数据库或公开元数据 API。 */
describe('iPhone strict image fingerprint store', () => {
  let db: Kysely<DB>;
  let repository: IphoneBackupImageRepository;
  let setup: ReturnType<typeof newMediumService<typeof LibraryService>>;
  let ownerId: string;
  let libraryId: string;
  const root = '/tmp/immich-synthetic-image-store';
  const historicalRoot = `${root}/Review`;
  const image = `${'a'.repeat(64)}:${'b'.repeat(64)}:${'c'.repeat(64)}`;

  /** 使用本套专属数据库副本，所有行均由各用例创建自己的用户和库隔离。 */
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  /** 仅关闭本套隔离数据库连接。 */
  afterAll(async () => {
    await db.destroy();
  });
  /** 为每例分配归属，防止不同测试的候选与来源相互影响。 */
  beforeEach(async () => {
    setup = newMediumService(LibraryService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await setup.ctx.newUser();
    ownerId = user.id;
    const library = await setup.ctx
      .get(LibraryRepository)
      .create({ ownerId, name: 'Synthetic image store', importPaths: [root], exclusionPatterns: [] });
    libraryId = library.id;
    repository = new IphoneBackupImageRepository(db);
  });

  /** @param options 用于验证特殊归属或状态的资产字段。@returns 不需要实际文件的数据库候选，实际文件验证属于上层服务。 */
  async function asset(options: Partial<Insertable<AssetTable>> = {}) {
    const originalPath = `${root}/Mobile/${randomUUID()}.jpg`;
    const { result } = await setup.ctx.newAsset({
      ownerId,
      libraryId,
      originalPath,
      originalFileName: 'synthetic.jpg',
      isExternal: true,
      type: AssetType.Image,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${originalPath}`).digest(),
      contentChecksum: createHash('sha1').update(originalPath).digest(),
      ...options,
    });
    return result;
  }

  /** @param source 实际测试行。@returns 按此资产版本提交的合成指纹证据，不宣称文件系统已经验证。 */
  function evidence(source: Awaited<ReturnType<typeof asset>>): IphoneImageFingerprintInput {
    return {
      assetId: source.id,
      originalPath: source.originalPath,
      updateId: source.updateId,
      fileChecksum: source.contentChecksum!,
      imageFingerprint: image,
      signature: '1:2:3:4:5',
      format: 'JPEG',
    };
  }

  /** @param source 当前上传行。@returns 服务端接收上传的原始来源描述，含完整版本信息。 */
  function upload(source: Awaited<ReturnType<typeof asset>>): IphoneUploadOriginInput {
    return {
      assetId: source.id,
      ownerId: source.ownerId,
      libraryId: source.libraryId!,
      originalPath: source.originalPath,
      checksum: source.contentChecksum!,
      recovery: Buffer.from('synthetic-recovery'),
      snapshot: {
        originalFileName: source.originalFileName,
        fileCreatedAt: new Date(source.fileCreatedAt).toISOString(),
        fileModifiedAt: new Date(source.fileModifiedAt).toISOString(),
        type: source.type,
        isFavorite: source.isFavorite,
        visibility: source.visibility,
        livePhotoVideoId: source.livePhotoVideoId,
        duration: source.duration,
      },
    };
  }

  /** 标签、GPS 或数据库拍摄日期变化不改变已核实的编码指纹；后续实际字节仍由业务层复核。 */
  it('finds equal image fingerprints despite different filenames and recorded dates', async () => {
    const source = await asset();
    await repository.recordFingerprint(evidence(source));
    await db
      .updateTable('asset')
      .set({ fileCreatedAt: new Date('1970-01-01T00:00:00Z'), originalFileName: 'renamed.jpg' })
      .where('id', '=', source.id)
      .execute();
    const rows = await repository.findByImage(ownerId, libraryId, image, randomUUID());
    expect(rows.map((row) => row.id)).toEqual([source.id]);
    expect(await repository.findByImage(ownerId, libraryId, image, source.id)).toEqual([]);
  });

  /** 相同指纹仍必须遵守用户和图库隔离，不能将视觉或二进制相同当作权限。 */
  it('filters other owners, other libraries and deleted or offline records', async () => {
    const source = await asset();
    await repository.recordFingerprint(evidence(source));
    expect(await repository.findByImage(randomUUID(), libraryId, image, randomUUID())).toEqual([]);
    expect(await repository.findByImage(ownerId, randomUUID(), image, randomUUID())).toEqual([]);
    await db.updateTable('asset').set({ isOffline: true }).where('id', '=', source.id).execute();
    expect(await repository.findByImage(ownerId, libraryId, image, randomUUID())).toEqual([]);
    await db
      .updateTable('asset')
      .set({ isOffline: false, deletedAt: new Date() })
      .where('id', '=', source.id)
      .execute();
    expect(await repository.findByImage(ownerId, libraryId, image, randomUUID())).toEqual([]);
  });

  /** 哈希或资产版本已变时不能发布旧读结果；已有陈旧索引也不能参与匹配。 */
  it('rejects stale commits and ignores stale indexed checksums', async () => {
    const source = await asset();
    const original = evidence(source);
    await repository.recordFingerprint(original);
    await db
      .updateTable('asset')
      .set({ contentChecksum: createHash('sha1').update('changed').digest() })
      .where('id', '=', source.id)
      .execute();
    await expect(repository.recordFingerprint(original)).rejects.toThrow('asset changed');
    expect(await repository.findByImage(ownerId, libraryId, image, randomUUID())).toEqual([]);
    const pending = await repository.indexingCandidates(ownerId, libraryId, historicalRoot);
    expect(pending.map((row) => row.id)).toContain(source.id);
  });

  /** 公共 asset_metadata 的同名键不会获得可信上传授权。 */
  it('does not accept ordinary imported files or public metadata as upload provenance', async () => {
    const source = await asset();
    expect(await repository.getUpload(source.id)).toBeUndefined();
    await db
      .insertInto('asset_metadata')
      .values({
        assetId: source.id,
        key: 'fork:iphone-upload-origin',
        value: { checksum: source.contentChecksum!.toString('hex') },
      })
      .execute();
    expect(await repository.getUpload(source.id)).toBeUndefined();
    await expect(repository.captureUpload({ ...upload(source), ownerId: randomUUID() })).rejects.toThrow(
      'asset changed',
    );
    await expect(repository.captureUpload({ ...upload(source), originalPath: `${root}/another.jpg` })).rejects.toThrow(
      'asset changed',
    );
  });

  /** 初次接收版本不可被之后的文件名、元数据或重复事件覆盖。 */
  it('captures immutable originals and preserves the first recovery recipe on replay', async () => {
    const source = await asset();
    const first = upload(source);
    await repository.captureUpload(first);
    const replay = await repository.captureUpload({
      ...first,
      recovery: Buffer.from('replacement'),
      snapshot: { ...first.snapshot, originalFileName: 'changed.jpg' },
    });
    expect(replay.recovery).toEqual(first.recovery);
    expect(replay.snapshot.originalFileName).toBe(first.snapshot.originalFileName);
    await db
      .updateTable('asset')
      .set({ contentChecksum: createHash('sha1').update('metadata rewrite').digest() })
      .where('id', '=', source.id)
      .execute();
    const saved = await repository.getUpload(source.id);
    expect(saved?.checksum).toEqual(first.checksum);
  });

  /** 已恢复版本后来被删除也不清空标记，避免后台再次创建同一用户删除的版本。 */
  it('keeps the recovered identity after explicit deletion and refuses replacing it', async () => {
    const source = await asset(),
      recovered = await asset();
    await repository.captureUpload(upload(source));
    await repository.markRecovered(source.id, recovered.id);
    await db.deleteFrom('asset').where('id', '=', recovered.id).execute();
    const saved = await repository.getUpload(source.id);
    expect(saved?.recoveredAssetId).toBe(recovered.id);
    await expect(repository.markRecovered(source.id, randomUUID())).rejects.toThrow('already recovered');
  });

  /** 内层仓储复用调用者持有的事务和源锁，不另借连接造成自锁。 */
  it('records protected snapshots inside an existing locked transaction', async () => {
    const source = await asset();
    const input = {
      sourceId: source.id,
      ownerId,
      libraryId,
      sourcePath: source.originalPath,
      checksum: source.contentChecksum!,
      path: `/tmp/immich-private-snapshot/${source.id}.jpg`,
      signature: 'snapshot:1:2:3:4',
    };
    await db.transaction().execute(async (tx) => {
      await tx.selectFrom('asset').select('id').where('id', '=', source.id).forUpdate().executeTakeFirstOrThrow();
      const nested = new IphoneBackupImageRepository(tx);
      await nested.captureUpload(upload(source));
      await nested.recordFingerprint(evidence(source));
      await nested.recordSnapshot(input);
    });
    const saved = await repository.getSnapshot(source.id, source.contentChecksum!);
    expect(saved?.path).toBe(input.path);
    expect(saved?.signature).toBe(input.signature);
    const recreated = await repository.recordSnapshot({ ...input, signature: 'snapshot:recreated:2:3:4' });
    expect(recreated.path).toBe(input.path);
    expect(recreated.signature).toBe('snapshot:recreated:2:3:4');
    expect(recreated.createdAt).toEqual(saved?.createdAt);
    await expect(repository.recordSnapshot({ ...input, path: '/tmp/other-snapshot.jpg' })).rejects.toThrow(
      'Conflicting source snapshot',
    );
  });

  /** 下载键、离线引用和同路径快照均是保留依赖；不以用户或当前可见性过滤这些安全检查。 */
  it('detects every current snapshot consumer without treating unrelated keys as dependencies', async () => {
    const source = await asset();
    const checksum = source.contentChecksum!;
    const snapshotPath = `/tmp/private/${source.id}/${checksum.toString('hex')}.jpg`;
    await repository.recordSnapshot({
      sourceId: source.id,
      ownerId,
      libraryId,
      sourcePath: source.originalPath,
      checksum,
      path: snapshotPath,
      signature: 'synthetic:1:2:3:4',
    });
    expect(await repository.hasSnapshotConsumers(source.id, checksum, snapshotPath)).toBe(true);
    await db
      .updateTable('asset')
      .set({ contentChecksum: createHash('sha1').update('later-version').digest() })
      .where('id', '=', source.id)
      .execute();
    expect(await repository.hasSnapshotConsumers(source.id, checksum, snapshotPath)).toBe(false);
    const version = await asset({
      originalPath: source.originalPath,
      contentChecksum: checksum,
      backupSourceId: source.id,
      backupChecksum: createHash('sha1').update('phone-version').digest(),
      backupMetadata: Buffer.from('synthetic-recovery'),
    });
    await db
      .updateTable('asset')
      .set({ isOffline: true, deletedAt: new Date() })
      .where('id', '=', version.id)
      .execute();
    expect(await repository.hasSnapshotConsumers(source.id, checksum, snapshotPath)).toBe(true);
    await db.deleteFrom('asset').where('id', '=', version.id).execute();
    const shared = await asset();
    await db
      .insertInto('fork_iphone_source_snapshot')
      .values({ sourceId: shared.id, checksum, path: snapshotPath, signature: 'synthetic:shared:2:3:4' })
      .execute();
    expect(await repository.hasSnapshotConsumers(source.id, checksum, snapshotPath)).toBe(true);
    await db.deleteFrom('fork_iphone_source_snapshot').where('sourceId', '=', shared.id).execute();
    const direct = await asset({ originalPath: snapshotPath });
    expect(await repository.hasSnapshotConsumers(source.id, checksum, snapshotPath)).toBe(true);
    await db.deleteFrom('asset').where('id', '=', direct.id).execute();
    expect(await repository.hasSnapshotConsumers(source.id, checksum, snapshotPath)).toBe(false);
  });

  /** 精确删除 API 不允许脱离原业务事务，也不允许清理普通源或在签名不符时删错记录。 */
  it('requires a trusted reference transaction and exact evidence before deleting a snapshot row', async () => {
    const version = await asset();
    const source = await asset();
    await repository.captureUpload(upload(version));
    const input = {
      assetId: version.id,
      checksum: version.contentChecksum!,
      path: `/tmp/private/${version.id}/${version.contentChecksum!.toString('hex')}.jpg`,
      signature: 'synthetic:1:2:3:4',
    };
    await repository.recordSnapshot({
      sourceId: version.id,
      ownerId,
      libraryId,
      sourcePath: version.originalPath,
      checksum: input.checksum,
      path: input.path,
      signature: input.signature,
    });
    await expect(repository.deleteRedundantUploadSnapshot(input)).rejects.toThrow('reference transaction');
    await expect(
      db.transaction().execute((tx) => new IphoneBackupImageRepository(tx).deleteRedundantUploadSnapshot(input)),
    ).rejects.toThrow('identity changed');
    await db
      .updateTable('asset')
      .set({
        originalPath: source.originalPath,
        contentChecksum: source.contentChecksum,
        backupSourceId: source.id,
        backupChecksum: input.checksum,
        backupOriginalPath: version.originalPath,
        backupMetadata: Buffer.from('synthetic-recovery'),
      })
      .where('id', '=', version.id)
      .execute();
    await expect(
      db
        .transaction()
        .execute((tx) =>
          new IphoneBackupImageRepository(tx).deleteRedundantUploadSnapshot({ ...input, signature: 'stale-signature' }),
        ),
    ).rejects.toThrow('changed before cleanup');
    expect(await repository.getSnapshot(version.id, input.checksum)).toBeDefined();
    await db.transaction().execute((tx) => new IphoneBackupImageRepository(tx).deleteRedundantUploadSnapshot(input));
    expect(await repository.getSnapshot(version.id, input.checksum)).toBeUndefined();
  });

  /** 指纹补算有界、排除暂存并跳过已就绪记录；来源巡检只检查有版本依赖或可信上传的源。 */
  it('pages indexing and source review without treating historical uploads as NAS sources', async () => {
    const indexed = await asset(),
      pending = await asset();
    await asset({ originalPath: `${historicalRoot}/staged.jpg` });
    await repository.recordFingerprint(evidence(indexed));
    const candidates = await repository.indexingCandidates(ownerId, libraryId, historicalRoot, 1);
    expect(candidates.map((row) => row.id)).toEqual([pending.id]);
    expect(await repository.sourceCandidates(ownerId, libraryId, historicalRoot)).toEqual([]);
    await repository.captureUpload(upload(indexed));
    const reviewed = await repository.sourceCandidates(ownerId, libraryId, historicalRoot);
    expect(reviewed.map((row) => row.id)).toEqual([indexed.id]);
    expect(reviewed[0].cachedSignature).toBe('1:2:3:4:5');
    expect(() => repository.indexingCandidates(ownerId, libraryId, historicalRoot, 0)).toThrow('limit');
    expect(() => repository.findByImage(ownerId, libraryId, image, randomUUID(), 65)).toThrow('limit');
  });

  /** HEIC/HEIF 扩展名进入同一归属和来源边界；格式证据由严格读取器提供，不因扩展名放宽权限。 */
  it('indexes HEIC and HEIF paths while keeping historical staging outside canonical sources', async () => {
    const heic = await asset({ originalPath: `${root}/Mobile/synthetic.HEIC` });
    const heif = await asset({ originalPath: `${root}/Mobile/synthetic.heif` });
    await asset({ originalPath: `${historicalRoot}/staged.HEIC` });
    await asset({ originalPath: `${root}/Mobile/unsupported.avif` });
    const pending = await repository.indexingCandidates(ownerId, libraryId, historicalRoot);
    expect(pending.map((row) => row.id).sort()).toEqual([heic.id, heif.id].sort());
    await repository.recordFingerprint({ ...evidence(heic), format: 'HEIC' });
    await repository.recordFingerprint({ ...evidence(heif), format: 'HEIC' });
    expect(await repository.getFingerprint(heic.id)).toMatchObject({ format: 'HEIC' });
    const matches = await repository.findByImage(ownerId, libraryId, image, heic.id);
    expect(matches.map((row) => row.id)).toEqual([heif.id]);
    expect(await repository.sourceCandidates(ownerId, libraryId, historicalRoot)).toEqual([]);
    await repository.captureUpload(upload(heic));
    const sources = await repository.sourceCandidates(ownerId, libraryId, historicalRoot);
    expect(sources.map((row) => row.id)).toEqual([heic.id]);
    expect(await repository.findByImage(randomUUID(), libraryId, image, randomUUID())).toEqual([]);
  });

  /** 新表、索引和默认值应与声明模型一致，不能留下启动时反复修正的 schema 漂移。 */
  it('matches migration tables to the schema model and refuses discarding recovery records on rollback', async () => {
    const { rows } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = rows[0].name;
    const target = await schemaFromDatabase({ connection: { connectionType: 'url', url: url.href } });
    const source = schemaFromCode({
      overrides: true,
      namingStrategy: 'default',
      uuidFunction: (version) => (version === 7 ? `${immich_uuid_v7.name}()` : 'uuid_generate_v4()'),
    });
    expect(
      schemaDiff(source, target)
        .asHuman()
        .filter((line) => /fork_iphone_(image_fingerprint|upload_origin|source_snapshot)/.test(line)),
    ).toEqual([]);
    const uploaded = await asset();
    await repository.captureUpload(upload(uploaded));
    await expect(down(db)).rejects.toThrow('Preserve upload origin');
    expect(await repository.getUpload(uploaded.id)).toBeDefined();
  });
});
