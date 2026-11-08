import { Kysely, sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import { assert } from 'vitest';
import { ChecksumAlgorithm } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { IphoneBackupReferenceService } from 'src/services/iphone-backup-reference.service.js';
import { IphoneBackupSourceService } from 'src/services/iphone-backup-source.service.js';
import { IphoneBackupUploadService } from 'src/services/iphone-backup-upload.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { restoreIphoneBackupImage } from 'src/utils/iphone-backup-image.js';
import { readIphoneBackupSnapshot } from 'src/utils/iphone-backup-snapshot.js';
import { createSyntheticIphoneHeic } from 'test/fixtures/iphone-heic.fixture.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** 用真实数据库触发器、ExifTool 和合成图片验证 NAS 元数据再次改写后的关联维护。 */
describe('iPhone backup source metadata refresh', () => {
  let db: Kysely<DB>;
  let temporary: string;
  let root: string;
  let review: string;
  let snapshots: string;
  let ownerId: string;
  let libraryId: string;
  let metadata: MetadataRepository;
  let context: ReturnType<typeof newMediumService<typeof LibraryService>>;
  let sources: IphoneBackupSourceService;

  /** 只使用 Testcontainers 生成的独立模板数据库，不读取实际部署配置。 */
  beforeAll(async () => {
    db = await getKyselyDB();
  });

  /** 所有用例结束后释放测试数据库连接。 */
  afterAll(async () => {
    await db?.destroy();
  });

  /** 每例独立用户、库、文件根、私有快照目录及 EXIF 进程，不接触生产图库。 */
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'immich-source-refresh-'));
    root = join(temporary, 'Photos/Mobile');
    review = join(temporary, 'Photos/Review');
    snapshots = join(temporary, 'Snapshots');
    await mkdir(root, { recursive: true });
    await mkdir(review, { recursive: true });
    await mkdir(snapshots, { mode: 0o700 });
    context = newMediumService(LibraryService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await context.ctx.newUser();
    ownerId = user.id;
    const library = await context.ctx.get(LibraryRepository).create({
      ownerId,
      name: 'Synthetic source refresh',
      importPaths: [join(temporary, 'Photos')],
      exclusionPatterns: [],
    });
    libraryId = library.id;
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', libraryId);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', root);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', review);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT', snapshots);
    metadata = new MetadataRepository(LoggingRepository.create());
    sources = new IphoneBackupSourceService(db, metadata);
  });

  /** 先结束 EXIF 读取，再删除本例独立合成文件和环境变量覆盖。 */
  afterEach(async () => {
    await metadata.teardown();
    await rm(temporary, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** @param format 合成图像格式。@returns 已严格关联的图像，完整上传副本仍保留以验证绝不删除文件。 */
  async function shared(format: 'jpeg' | 'png' = 'jpeg') {
    const suffix = format === 'jpeg' ? 'jpg' : 'png';
    const sourcePath = join(root, `source.${suffix}`),
      stagePath = join(review, `phone.${suffix}`);
    const phone = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#335577' } })
      .toFormat(format)
      .toBuffer();
    await writeFile(stagePath, phone);
    await writeFile(sourcePath, phone);
    await metadata.writeTags(sourcePath, { Keywords: ['shared'] });
    const sourceBytes = await readFile(sourcePath);
    const { result: source } = await context.ctx.newAsset({
      ownerId,
      libraryId,
      originalPath: sourcePath,
      originalFileName: `source.${suffix}`,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${sourcePath}`).digest(),
      contentChecksum: createHash('sha1').update(sourceBytes).digest(),
    });
    const { result: version } = await context.ctx.newAsset({
      ownerId,
      libraryId,
      originalPath: stagePath,
      originalFileName: `phone.${suffix}`,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${stagePath}`).digest(),
      contentChecksum: createHash('sha1').update(phone).digest(),
      fileCreatedAt: source.fileCreatedAt,
    });
    const references = new IphoneBackupReferenceService(db, metadata);
    const plan = await references.assessAsset(version.id);
    assert(plan?.plan);
    await references.prepare(plan.plan);
    return { source, version, sourcePath, stagePath, phone, sourceBytes };
  }

  /** @param format 合成上传格式。@param originalBytes 可选的有界合成原片字节。@returns 已通过可信内部上传事件固定原始版本的普通备份文件。 */
  async function captured(format: 'jpeg' | 'png' | 'heic' = 'jpeg', originalBytes?: Buffer) {
    const suffix = format === 'jpeg' ? 'jpg' : format;
    const sourcePath = join(root, `new-upload.${suffix}`);
    const phone =
      originalBytes ??
      (format === 'heic'
        ? createSyntheticIphoneHeic()
        : await sharp({ create: { width: 32, height: 24, channels: 3, background: '#335577' } })
            .toFormat(format)
            .toBuffer());
    await writeFile(sourcePath, phone);
    const checksum = createHash('sha1').update(phone).digest();
    const { result: source } = await context.ctx.newAsset({
      ownerId,
      libraryId,
      originalPath: sourcePath,
      originalFileName: `new-upload.${suffix}`,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${sourcePath}`).digest(),
      contentChecksum: checksum,
    });
    await new IphoneBackupUploadService(db).onBackupUpload({ assetId: source.id });
    return { source, sourcePath, phone, checksum };
  }

  /** HEIC 初始上传与 NAS 元数据版本分别保留完整身份，严格 v2 关联后仍能下载精确手机版本。 */
  it('recovers and associates a captured HEIC after metadata rewriting with exact original downloads', async () => {
    const p = await captured('heic');
    const changed = createSyntheticIphoneHeic('shared and corrected metadata');
    await writeFile(p.sourcePath, changed);
    const result = await sources.refreshSource(p.source.id);
    assert(result.recoveredAssetId);
    expect(result.status).toBe('refreshed');
    const recovered = await db
      .selectFrom('asset')
      .selectAll()
      .where('id', '=', result.recoveredAssetId)
      .executeTakeFirstOrThrow();
    expect(recovered.originalPath.endsWith('.heic')).toBe(true);
    expect(await readFile(recovered.originalPath)).toEqual(p.phone);
    expect(recovered.contentChecksum).toEqual(p.checksum);
    const source = await db.selectFrom('asset').selectAll().where('id', '=', p.source.id).executeTakeFirstOrThrow();
    expect(source.contentChecksum).toEqual(createHash('sha1').update(changed).digest());
    const references = new IphoneBackupReferenceService(db, metadata);
    const assessment = await references.assessAsset(recovered.id);
    assert(assessment?.plan);
    expect(assessment.plan.sourceId).toBe(p.source.id);
    await references.prepare(assessment.plan);
    const alias = await db.selectFrom('asset').selectAll().where('id', '=', recovered.id).executeTakeFirstOrThrow();
    expect(alias.backupChecksum).toEqual(p.checksum);
    expect(alias.clientChecksum).toEqual(p.checksum);
    expect(alias.isOffline).toBe(false);
    expect(JSON.parse(gunzipSync(alias.backupMetadata!).toString('utf8'))).toMatchObject({
      version: 2,
      format: 'HEIC',
    });
    const download = await context.ctx.get(AssetRepository).getForOriginal(alias.id, false);
    assert(download.originalPath && download.backupMetadata);
    expect(restoreIphoneBackupImage(await readFile(download.originalPath), download.backupMetadata)).toEqual(p.phone);
    const representatives = await db
      .selectFrom('asset')
      .select('id')
      .where('ownerId', '=', ownerId)
      .where('clientChecksum', '=', p.checksum)
      .execute();
    expect(representatives).toEqual([{ id: alias.id }]);
    expect(await readFile(p.sourcePath)).toEqual(changed);
    const repeated = await sources.refreshSource(p.source.id);
    expect(repeated.recoveredAssetId).toBe(alias.id);
    expect(await db.selectFrom('asset').select('id').where('libraryId', '=', libraryId).execute()).toHaveLength(2);
  });

  /** 配方超限不会失去完整来源证据；后续 NAS 改标签仍能固定最初上传文件且不删除完整暂存版本。 */
  it('recovers a captured large-metadata PNG directly from its immutable full snapshot', async () => {
    const base = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#446688' } })
      .png()
      .toBuffer();
    const text = Buffer.from(`Comment\0${randomBytes(1024 * 1024).toString('base64')}`, 'ascii');
    const chunk = Buffer.alloc(text.length + 12);
    chunk.writeUInt32BE(text.length, 0);
    chunk.write('tEXt', 4, 'ascii');
    text.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const bytes = Buffer.concat([base.subarray(0, -12), chunk, base.subarray(-12)]);
    expect(await sharp(bytes).raw().toBuffer()).toEqual(await sharp(base).raw().toBuffer());
    const p = await captured('png', bytes);
    const origin = await db
      .selectFrom('fork_iphone_upload_origin')
      .selectAll()
      .where('assetId', '=', p.source.id)
      .executeTakeFirstOrThrow();
    expect(origin.recovery).toBeNull();
    await metadata.writeTags(p.sourcePath, { Keywords: ['shared', 'corrected-location'] });
    const changed = await readFile(p.sourcePath);
    expect(changed).not.toEqual(bytes);
    const result = await sources.refreshSource(p.source.id);
    assert(result.recoveredAssetId);
    const restored = await db
      .selectFrom('asset')
      .selectAll()
      .where('id', '=', result.recoveredAssetId)
      .executeTakeFirstOrThrow();
    expect(restored.contentChecksum).toEqual(p.checksum);
    expect(restored.clientChecksum).toEqual(p.checksum);
    expect(restored.backupChecksum).toBeNull();
    expect(await readFile(restored.originalPath)).toEqual(bytes);
    expect(await readFile(p.sourcePath)).toEqual(changed);
    expect(
      await db.selectFrom('asset').select('contentChecksum').where('id', '=', p.source.id).executeTakeFirstOrThrow(),
    ).toEqual({ contentChecksum: createHash('sha1').update(changed).digest() });
    const repeated = await sources.refreshSource(p.source.id);
    expect(repeated.recoveredAssetId).toBe(restored.id);
    expect(await readdir(join(review, '.fork-origin-versions'))).toHaveLength(1);
  }, 30_000);

  /** 新上传的原始身份先固定，再修改时间、GPS、标签；恢复真实文件后仍由既有严格关联流程匹配。 */
  it.each(['jpeg', 'png'] as const)(
    'recovers a captured %s upload after NAS metadata changes without losing backup identity',
    async (format) => {
      const p = await captured(format);
      await metadata.writeTags(p.sourcePath, {
        DateTimeOriginal: '2024:02:03 12:13:14',
        GPSLatitude: 22.33,
        GPSLongitude: 114.1,
        Keywords: ['shared', 'corrected-location'],
      });
      const changed = await readFile(p.sourcePath);
      const refreshed = await sources.refreshSource(p.source.id);
      expect(refreshed.status).toBe('refreshed');
      assert(refreshed.recoveredAssetId);
      const recovered = await db
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', refreshed.recoveredAssetId)
        .executeTakeFirstOrThrow();
      expect(recovered.originalPath.startsWith(join(review, '.fork-origin-versions'))).toBe(true);
      expect(recovered.contentChecksum).toEqual(p.checksum);
      expect(await readFile(recovered.originalPath)).toEqual(p.phone);
      const source = await db.selectFrom('asset').selectAll().where('id', '=', p.source.id).executeTakeFirstOrThrow();
      expect(source.contentChecksum).toEqual(createHash('sha1').update(changed).digest());
      const references = new IphoneBackupReferenceService(db, metadata);
      const assessment = await references.assessAsset(recovered.id);
      assert(assessment?.plan);
      expect(assessment.plan.sourceId).toBe(p.source.id);
      await references.prepare(assessment.plan);
      const alias = await db.selectFrom('asset').selectAll().where('id', '=', recovered.id).executeTakeFirstOrThrow();
      expect(alias.backupChecksum).toEqual(p.checksum);
      expect(alias.clientChecksum).toEqual(p.checksum);
      expect(alias.isOffline).toBe(false);
      expect(restoreIphoneBackupImage(changed, alias.backupMetadata!)).toEqual(p.phone);
      expect(
        await db
          .selectFrom('asset')
          .select('id')
          .where('ownerId', '=', ownerId)
          .where('clientChecksum', '=', p.checksum)
          .execute(),
      ).toHaveLength(1);
      expect(await readFile(p.sourcePath)).toEqual(changed);
      const repeated = await sources.refreshSource(p.source.id);
      expect(repeated.recoveredAssetId).toBe(recovered.id);
      expect(await db.selectFrom('asset').select('id').where('libraryId', '=', libraryId).execute()).toHaveLength(2);
      expect(await readdir(join(review, '.fork-origin-versions'))).toHaveLength(1);
    },
  );

  /** 用户明确删除恢复身份后，持久来源标记防止下一轮巡检重新创建同一手机版本。 */
  it('does not resurrect an explicitly deleted recovered upload version', async () => {
    const p = await captured();
    await metadata.writeTags(p.sourcePath, { Keywords: ['shared'] });
    const result = await sources.refreshSource(p.source.id);
    assert(result.recoveredAssetId);
    const recovered = await db
      .selectFrom('asset')
      .select('originalPath')
      .where('id', '=', result.recoveredAssetId)
      .executeTakeFirstOrThrow();
    await db.deleteFrom('asset').where('id', '=', result.recoveredAssetId).execute();
    await unlink(recovered.originalPath);
    await metadata.writeTags(p.sourcePath, { Keywords: ['shared', 'later-update'] });
    await sources.refreshSource(p.source.id);
    expect(await db.selectFrom('asset').select('id').where('libraryId', '=', libraryId).execute()).toEqual([
      { id: p.source.id },
    ]);
    expect(await readdir(join(review, '.fork-origin-versions'))).toEqual([]);
    const origin = await db
      .selectFrom('fork_iphone_upload_origin')
      .select('recoveredAssetId')
      .where('assetId', '=', p.source.id)
      .executeTakeFirstOrThrow();
    expect(origin.recoveredAssetId).toBe(result.recoveredAssetId);
  });

  /** 实际数据库拒绝恢复资产时，事务和新建暂存文件都回滚，原 NAS 文件及私有底稿保持完好。 */
  it.each(['insert', 'source-update'] as const)(
    'removes only the newly restored file when the recovery %s fails',
    async (phase) => {
      const p = await captured();
      await metadata.writeTags(p.sourcePath, { Keywords: ['shared'] });
      const changed = await readFile(p.sourcePath);
      await sql
        .raw(
          `CREATE FUNCTION fork_test_recovery_failure() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN IF (TG_OP = 'INSERT' AND strpos(NEW."originalPath", '/.fork-origin-versions/') > 0)
        OR (TG_OP = 'UPDATE' AND OLD."contentChecksum" IS DISTINCT FROM NEW."contentChecksum") THEN
        RAISE EXCEPTION 'Synthetic recovery database failure'; END IF; RETURN NEW; END $$`,
        )
        .execute(db);
      const triggerEvent = phase === 'insert' ? 'INSERT' : 'UPDATE OF "contentChecksum"';
      await sql
        .raw(
          `CREATE TRIGGER fork_test_recovery_failure BEFORE ${triggerEvent} ON asset FOR EACH ROW EXECUTE FUNCTION fork_test_recovery_failure()`,
        )
        .execute(db);
      try {
        await expect(sources.refreshSource(p.source.id)).rejects.toThrow('Synthetic recovery database failure');
      } finally {
        await sql.raw('DROP TRIGGER fork_test_recovery_failure ON asset').execute(db);
        await sql.raw('DROP FUNCTION fork_test_recovery_failure()').execute(db);
      }
      expect(await readdir(join(review, '.fork-origin-versions'))).toEqual([]);
      const source = await db
        .selectFrom('asset')
        .select('contentChecksum')
        .where('id', '=', p.source.id)
        .executeTakeFirstOrThrow();
      expect(source.contentChecksum).toEqual(p.checksum);
      const origin = await db
        .selectFrom('fork_iphone_upload_origin')
        .select('recoveredAssetId')
        .where('assetId', '=', p.source.id)
        .executeTakeFirstOrThrow();
      expect(origin.recoveredAssetId).toBeNull();
      expect(await readFile(p.sourcePath)).toEqual(changed);
      const snapshot = await db
        .selectFrom('fork_iphone_source_snapshot')
        .selectAll()
        .where('sourceId', '=', p.source.id)
        .where('checksum', '=', p.checksum)
        .executeTakeFirstOrThrow();
      expect(
        await readIphoneBackupSnapshot({ path: snapshot.path, root: snapshots, checksum: p.checksum.toString('hex') }),
      ).toEqual(p.phone);
    },
  );

  /** 时间、位置、标签等均可改变，必须仍恢复出完全相同的手机文件并保留原有匹配身份。 */
  it('keeps the phone identity after capture-time, GPS and arbitrary keyword changes', async () => {
    const p = await shared();
    const before = await db
      .selectFrom('asset')
      .select(['id', 'clientChecksum'])
      .where('id', '=', p.version.id)
      .executeTakeFirstOrThrow();
    await metadata.writeTags(p.sourcePath, {
      DateTimeOriginal: '2024:02:03 12:13:14',
      GPSLatitude: 22.33,
      GPSLongitude: 114.1,
      Keywords: ['shared', 'new-label'],
      Subject: ['location-corrected'],
    });
    const bytes = await readFile(p.sourcePath);
    const result = await sources.refreshSource(p.source.id);
    expect(result).toMatchObject({ status: 'refreshed', restoredReferences: 1, invalidReferences: 0 });
    const version = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    expect(version.id).toBe(before.id);
    expect(version.clientChecksum).toEqual(before.clientChecksum);
    expect(version.isOffline).toBe(false);
    expect(version.contentChecksum).toEqual(createHash('sha1').update(bytes).digest());
    expect(restoreIphoneBackupImage(bytes, version.backupMetadata!)).toEqual(p.phone);
    expect(await readFile(p.sourcePath)).toEqual(bytes);
    expect(await readFile(p.stagePath)).toEqual(p.phone);
  });

  /** PNG 文本和 EXIF 块变化也采用原样重建证明，不能以 JPEG 特例误判完成。 */
  it('preserves a PNG phone identity when PNG text and EXIF metadata change', async () => {
    const p = await shared('png');
    const before = await db
      .selectFrom('asset')
      .select('clientChecksum')
      .where('id', '=', p.version.id)
      .executeTakeFirstOrThrow();
    await metadata.writeTags(p.sourcePath, {
      Description: 'PNG corrected location',
      DateTimeOriginal: '2024:02:03 12:13:14',
      Keywords: ['shared', 'reclassified'],
    });
    const bytes = await readFile(p.sourcePath);
    expect(bytes).not.toEqual(p.sourceBytes);
    expect(await sources.refreshSource(p.source.id)).toMatchObject({
      status: 'refreshed',
      restoredReferences: 1,
      invalidReferences: 0,
    });
    const version = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    expect(version.clientChecksum).toEqual(before.clientChecksum);
    expect(restoreIphoneBackupImage(bytes, version.backupMetadata!)).toEqual(p.phone);
    expect(await readFile(p.stagePath)).toEqual(p.phone);
  });

  /** 元数据读取器报错不能被当成未知标签忽略，否则会在缺失证据时推进源指纹。 */
  it('fails without publishing new checksums when the metadata reader fails', async () => {
    const p = await shared();
    await metadata.writeTags(p.sourcePath, { Description: 'Synthetic correction' });
    vi.spyOn(metadata, 'readBackupTags').mockRejectedValue(new Error('Synthetic metadata read failure'));
    await expect(sources.refreshSource(p.source.id)).rejects.toThrow('Synthetic metadata read failure');
    const source = await db
      .selectFrom('asset')
      .select('contentChecksum')
      .where('id', '=', p.source.id)
      .executeTakeFirstOrThrow();
    expect(source.contentChecksum).toEqual(p.source.contentChecksum);
    expect(await readFile(p.stagePath)).toEqual(p.phone);
  });

  /** 自动晋升不能在源元数据刷新时把既有代表切换到另一个同内容物理副本。 */
  it('does not move the client checksum representative to another complete copy', async () => {
    const p = await shared();
    const duplicatePath = join(root, 'independent-phone-copy.jpg');
    await writeFile(duplicatePath, p.phone);
    const { result: duplicate } = await context.ctx.newAsset({
      ownerId,
      libraryId,
      originalPath: duplicatePath,
      originalFileName: 'independent-phone-copy.jpg',
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${duplicatePath}`).digest(),
      contentChecksum: createHash('sha1').update(p.phone).digest(),
    });
    const before = await db
      .selectFrom('asset')
      .select(['id', 'clientChecksum'])
      .where('id', 'in', [p.version.id, duplicate.id])
      .orderBy('id')
      .execute();
    await metadata.writeTags(p.sourcePath, { Description: 'Synthetic corrected location' });
    await sources.refreshSource(p.source.id);
    const after = await db
      .selectFrom('asset')
      .select(['id', 'clientChecksum'])
      .where('id', 'in', [p.version.id, duplicate.id])
      .orderBy('id')
      .execute();
    expect(after).toEqual(before);
  });

  /** 已被普通扫描撤销的映射，仅在当前字节完整恢复验证通过后才允许恢复。 */
  it('heals a reference invalidated by an earlier content-checksum scan', async () => {
    const p = await shared();
    await metadata.writeTags(p.sourcePath, { Keywords: ['shared', 'corrected'] });
    const checksum = createHash('sha1')
      .update(await readFile(p.sourcePath))
      .digest();
    await context.ctx.get(AssetRepository).update({ id: p.source.id, contentChecksum: checksum });
    const preserved = await db
      .selectFrom('asset')
      .select('isOffline')
      .where('id', '=', p.version.id)
      .executeTakeFirstOrThrow();
    expect(preserved.isOffline).toBe(false);
    // 模拟先前版本已置为离线的遗留引用；自动复核不能只依赖数据库状态恢复。
    await db.updateTable('asset').set({ isOffline: true }).where('id', '=', p.version.id).execute();
    expect(await sources.refreshSource(p.source.id)).toMatchObject({ status: 'refreshed', restoredReferences: 1 });
    const healed = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    expect(healed.isOffline).toBe(false);
    expect(healed.backupChecksum).toEqual(createHash('sha1').update(p.phone).digest());
  });

  /** 真正的新图像编码不属于元数据修订，缺少旧快照时必须保持旧版本离线。 */
  it('invalidates the old reference when actual image data changes', async () => {
    const p = await shared();
    await db.deleteFrom('fork_iphone_source_snapshot').where('sourceId', '=', p.source.id).execute();
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#aa4422' } })
      .jpeg()
      .toBuffer();
    await writeFile(p.sourcePath, bytes);
    expect(await sources.refreshSource(p.source.id)).toMatchObject({
      status: 'image_changed',
      invalidReferences: 1,
      restoredReferences: 0,
    });
    const version = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    expect(version.isOffline).toBe(true);
    expect(version.clientChecksum).toBeNull();
    expect(await readFile(p.stagePath)).toEqual(p.phone);
  });

  /** 真正的图像编辑保留旧私有快照及手机版本身份，不把当前新图像伪装成旧版本。 */
  it('keeps the old phone version recoverable when NAS image data really changes', async () => {
    const p = await shared();
    const before = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    const old = await db
      .selectFrom('fork_iphone_source_snapshot')
      .selectAll()
      .where('sourceId', '=', p.source.id)
      .where('checksum', '=', before.contentChecksum!)
      .executeTakeFirstOrThrow();
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#aa4422' } })
      .jpeg()
      .toBuffer();
    await writeFile(p.sourcePath, bytes);
    expect(await sources.refreshSource(p.source.id)).toMatchObject({
      status: 'image_changed',
      retainedReferences: 1,
      invalidReferences: 0,
      restoredReferences: 0,
    });
    const version = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    expect(version.isOffline).toBe(false);
    expect(version.clientChecksum).toEqual(before.clientChecksum);
    expect(version.contentChecksum).toEqual(before.contentChecksum);
    const preserved = await readIphoneBackupSnapshot({
      path: old.path,
      root: snapshots,
      checksum: old.checksum.toString('hex'),
    });
    expect(restoreIphoneBackupImage(preserved, version.backupMetadata!)).toEqual(p.phone);
    expect(await readFile(p.sourcePath)).toEqual(bytes);
    expect(await readFile(p.stagePath)).toEqual(p.phone);
  });

  /** 保留文件损坏时拒绝修改源指纹，不能只相信快照表里仍有记录。 */
  it('rejects a corrupt pinned snapshot instead of healing a changed-image reference', async () => {
    const p = await shared();
    const old = await db
      .selectFrom('fork_iphone_source_snapshot')
      .selectAll()
      .where('sourceId', '=', p.source.id)
      .executeTakeFirstOrThrow();
    await writeFile(old.path, Buffer.from('corrupt snapshot'));
    const changed = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#aa4422' } })
      .jpeg()
      .toBuffer();
    await writeFile(p.sourcePath, changed);
    await expect(sources.refreshSource(p.source.id)).rejects.toThrow();
    const source = await db
      .selectFrom('asset')
      .select('contentChecksum')
      .where('id', '=', p.source.id)
      .executeTakeFirstOrThrow();
    expect(source.contentChecksum).toEqual(p.source.contentChecksum);
    expect(await readFile(p.stagePath)).toEqual(p.phone);
  });

  /** 自动复核不允许退回到缺少原始版本保留文件的旧行为。 */
  it('requires an explicit private snapshot root before revalidating a source', async () => {
    const p = await shared();
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT', '');
    await expect(sources.refreshSource(p.source.id)).rejects.toThrow('snapshot root');
    expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
  });

  /** 损坏恢复资料不能伪装成图像变化并继续提交源指纹。 */
  it('rolls back on corrupt recovery records without changing any files', async () => {
    const p = await shared();
    await db
      .updateTable('asset')
      .set({ backupMetadata: Buffer.from('broken-recipe') })
      .where('id', '=', p.version.id)
      .execute();
    await metadata.writeTags(p.sourcePath, { Keywords: ['updated-label'] });
    await expect(sources.refreshSource(p.source.id)).rejects.toThrow();
    const source = await db
      .selectFrom('asset')
      .select('contentChecksum')
      .where('id', '=', p.source.id)
      .executeTakeFirstOrThrow();
    expect(source.contentChecksum).toEqual(p.source.contentChecksum);
    expect(await readFile(p.stagePath)).toEqual(p.phone);
  });

  /** 未发生新的文件或状态变化时不更新资产游标，避免重复同步及反复创建任务。 */
  it('does not rewrite rows when an already-refreshed source is unchanged', async () => {
    const p = await shared();
    await metadata.writeTags(p.sourcePath, { Description: 'Synthetic correction' });
    await sources.refreshSource(p.source.id);
    const before = await db
      .selectFrom('asset')
      .select(['id', 'updateId'])
      .where('id', 'in', [p.source.id, p.version.id])
      .orderBy('id')
      .execute();
    expect(await sources.refreshSource(p.source.id)).toMatchObject({ status: 'unchanged' });
    const after = await db
      .selectFrom('asset')
      .select(['id', 'updateId'])
      .where('id', 'in', [p.source.id, p.version.id])
      .orderBy('id')
      .execute();
    expect(after).toEqual(before);
  });

  /** 即使路径可读也不允许跨用户或跨图库复核其数据。 */
  it('rejects a source from another owner and preserves every existing reference', async () => {
    const p = await shared();
    const { user } = await context.ctx.newUser();
    const library = await context.ctx
      .get(LibraryRepository)
      .create({ ownerId: user.id, name: 'Other synthetic source', importPaths: [root], exclusionPatterns: [] });
    const { result: other } = await context.ctx.newAsset({
      ownerId: user.id,
      libraryId: library.id,
      originalPath: p.sourcePath,
    });
    await expect(sources.refreshSource(other.id)).rejects.toThrow('ownership');
    expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
    expect(await readFile(p.stagePath)).toEqual(p.phone);
  });
});
