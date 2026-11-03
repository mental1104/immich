import { schemaFromCode } from '@immich/sql-tools';
import { ExifDateTime } from 'exiftool-vendored';
import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { assert } from 'vitest';
import type { UploadFile } from 'src/types.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetMediaCreateDto } from 'src/dtos/asset-media.dto.js';
import { AssetVisibility, ChecksumAlgorithm, JobName, SyncRequestType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { SyncTestContext, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;

/** 全部测试使用 Testcontainers 生成的独立数据库以及临时原片目录。 */
beforeAll(async () => {
  database = await getKyselyDB();
});

/**
 * 创建一个已有明确内容和服务端 SHA-1 的上传暂存文件。
 * @param directory 当前测试专属临时目录。
 * @param content 测试用无隐私文本，不是真实照片。
 * @param originalName 用于检验扩展名和重命名规则的客户端文件名。
 * @returns 完整上传文件描述，调用者的临时目录清理负责释放文件。
 */
async function makeUpload(directory: string, content: string, originalName = 'source.HEIC'): Promise<UploadFile> {
  const originalPath = join(directory, `${randomUUID()}${extname(originalName).toLowerCase()}`);
  await writeFile(originalPath, content);
  return {
    originalPath,
    originalName,
    uuid: randomUUID(),
    size: Buffer.byteLength(content),
    checksum: createHash('sha1').update(content).digest(),
  };
}

/**
 * 建立真实上传存储和数据库依赖；EXIF 返回值由测试设置。
 * @param database Testcontainers 的隔离数据库连接。
 * @returns 服务及依赖访问器，测试负责关闭 EXIF 资源。
 */
function createContext(database: Kysely<DB>) {
  return newMediumService(AssetMediaService, {
    database,
    real: [
      AccessRepository,
      AssetRepository,
      CryptoRepository,
      DatabaseRepository,
      LibraryRepository,
      MetadataRepository,
      StorageRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
}

/** 贯通真实文件发布、外部库建档、并发去重以及官方客户端使用的初次同步数据。 */
describe('iPhone external library backup', () => {
  let temporary: string;
  let root: string;
  let setup: ReturnType<typeof createContext>;
  let userId: string;
  let libraryId: string;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'immich-iphone-backup-'));
    root = join(temporary, 'Photos/MobileBackup/iPhone');
    await mkdir(root, { recursive: true });
    setup = createContext(database);
    const { user } = await setup.ctx.newUser();
    userId = user.id;
    const library = await setup.ctx.get(LibraryRepository).create({
      ownerId: userId,
      name: 'Backup test',
      importPaths: [join(temporary, 'Photos')],
      exclusionPatterns: [],
    });
    libraryId = library.id;
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', libraryId);
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', root);
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_AUDIT', 'true');
    setup.ctx.getMock(JobRepository).queue.mockResolvedValue();
    setup.ctx.getMock(EventRepository).emit.mockResolvedValue();
    vitest
      .spyOn(setup.ctx.get(MetadataRepository), 'readTags')
      .mockResolvedValue({ DateTimeOriginal: ExifDateTime.fromISO('2026-11-03T11:10:00+08:00')! });
  });

  afterEach(async () => {
    await setup.ctx.get(MetadataRepository).teardown();
    vitest.unstubAllEnvs();
    await rm(temporary, { recursive: true, force: true });
  });

  /**
   * 以当前用户提交上传，故意使用不同于 EXIF 的手机创建时间验证拍摄时间优先。
   * @param file 本次完整暂存文件。
   * @param options 可选的 Live Photo 关联和可见性字段。
   * @returns 标准上传 API 的结果，不运行异步缩略图任务。
   */
  function upload(file: UploadFile, options: Partial<AssetMediaCreateDto> = {}) {
    return setup.sut.uploadAsset(
      factory.auth({ user: { id: userId } }),
      {
        fileCreatedAt: new Date('2025-01-01T00:00:00Z'),
        fileModifiedAt: new Date('2026-11-03T03:10:00Z'),
        assetData: Buffer.from('unused'),
        ...options,
      },
      file,
    );
  }

  it('uses capture time, preserves HEIC and creates an actual external asset', async () => {
    const file = await makeUpload(temporary, 'original-file');
    const result = await upload(file);
    const destination = join(root, '2026/11/IMG_20261103_111000.HEIC');
    expect(await readFile(destination, 'utf8')).toBe('original-file');
    const asset = await setup.ctx.get(AssetRepository).getById(result.id);
    expect(asset).toMatchObject({
      originalPath: destination,
      libraryId,
      ownerId: userId,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      contentChecksum: file.checksum,
    });
    expect(setup.ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetCreate', {
      asset: expect.objectContaining({ id: result.id }),
      file: undefined,
    });
    expect(setup.ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
      name: JobName.AssetExtractMetadata,
      data: expect.objectContaining({ id: result.id }),
    });
  });

  it('registers the partial index definition expected by the upstream schema checker', async () => {
    const expected = schemaFromCode({ overrides: true, namingStrategy: 'default' }).overrides.find(
      (item) => item.name === 'index_fork_asset_content_checksum_idx',
    );
    assert(expected);
    const actual = await sql<{
      value: typeof expected.value;
    }>`SELECT "value" FROM "migration_overrides" WHERE "name" = ${expected.name}`.execute(database);
    expect(actual.rows[0].value).toEqual(expected.value);
  });

  it('serializes simultaneous duplicate uploads and keeps one external record and one file', async () => {
    const results = await Promise.all([
      upload(await makeUpload(temporary, 'same')),
      upload(await makeUpload(temporary, 'same')),
    ]);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.map((result) => result.status).sort()).toEqual(
      [AssetMediaStatus.CREATED, AssetMediaStatus.DUPLICATE].sort(),
    );
    expect(await readdir(join(root, '2026/11'))).toEqual(['IMG_20261103_111000.HEIC']);
  });

  it('does not overwrite a different file captured in the same second', async () => {
    await upload(await makeUpload(temporary, 'first'));
    const second = await upload(await makeUpload(temporary, 'second'));
    expect(await readFile(join(root, '2026/11/IMG_20261103_111000.HEIC'), 'utf8')).toBe('first');
    const secondAsset = await setup.ctx.get(AssetRepository).getById(second.id);
    expect(secondAsset?.originalPath).toBe(join(root, '2026/11/IMG_20261103_111000+1.HEIC'));
  });

  it('finds already scanned external files by content before first phone backup', async () => {
    const existingPath = join(temporary, 'Photos/existing.HEIC');
    await writeFile(existingPath, 'already-on-nas');
    const scanner = newMediumService(LibraryService, {
      database,
      real: [
        AssetRepository,
        AssetJobRepository,
        CryptoRepository,
        DatabaseRepository,
        LibraryRepository,
        StorageRepository,
      ],
      mock: [EventRepository, JobRepository, LoggingRepository],
    });
    scanner.ctx.getMock(EventRepository).emit.mockResolvedValue();
    scanner.ctx.getMock(JobRepository).queue.mockResolvedValue();
    scanner.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
    await scanner.sut.handleSyncFiles({ libraryId, paths: [existingPath] });
    const file = await makeUpload(temporary, 'already-on-nas');
    const result = await upload(file);
    expect(result.status).toBe(AssetMediaStatus.DUPLICATE);
    const existing = await setup.ctx.get(AssetRepository).getById(result.id);
    expect(existing?.originalPath).toBe(existingPath);

    // 模拟一个从未同步过的客户端会话，核验首次流中提供的是内容 SHA-1。
    const sync = new SyncTestContext(database);
    const { session } = await sync.newSession({ userId });
    const response = await sync.syncStream(factory.auth({ user: { id: userId }, session: { id: session.id } }), [
      SyncRequestType.AssetsV2,
    ]);
    expect(response).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ id: result.id, libraryId, checksum: file.checksum.toString('base64') }),
      }),
    );
    expect(sync.getMock(LoggingRepository).log).toHaveBeenCalledWith(
      expect.stringContaining('"event":"sync_asset_sent"'),
    );
  });

  it('backfills old path-hashed records and preserves same-content files at different paths', async () => {
    const path1 = join(temporary, 'Photos/a.HEIC');
    const path2 = join(temporary, 'Photos/b.HEIC');
    await writeFile(path1, 'same-content');
    await writeFile(path2, 'same-content');
    const repo = setup.ctx.get(AssetRepository);
    const path1Stats = await stat(path1);
    const { asset } = await setup.ctx.newAsset({
      ownerId: userId,
      libraryId,
      isExternal: true,
      originalPath: path1,
      checksum: createHash('sha1').update(`path:${path1}`).digest(),
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      fileModifiedAt: path1Stats.mtime,
    });
    const scanner = newMediumService(LibraryService, {
      database,
      real: [
        AssetRepository,
        AssetJobRepository,
        CryptoRepository,
        DatabaseRepository,
        LibraryRepository,
        StorageRepository,
      ],
      mock: [EventRepository, JobRepository, LoggingRepository],
    });
    scanner.ctx.getMock(EventRepository).emit.mockResolvedValue();
    scanner.ctx.getMock(JobRepository).queue.mockResolvedValue();
    scanner.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
    await scanner.sut.handleSyncAssets({
      libraryId,
      assetIds: [asset.id],
      importPaths: [join(temporary, 'Photos')],
      exclusionPatterns: [],
      progressCounter: 1,
      totalAssets: 1,
    });
    const checksum = createHash('sha1').update('same-content').digest();
    const backfilled = await repo.getById(asset.id);
    expect(backfilled?.contentChecksum).toEqual(checksum);
    await scanner.sut.handleSyncFiles({ libraryId, paths: [path2] });
    const matches = await repo.getByChecksums(userId, [checksum]);
    expect(matches).toHaveLength(2);
    await unlink(path1);
    await scanner.sut.handleSyncAssets({
      libraryId,
      assetIds: [asset.id],
      importPaths: [join(temporary, 'Photos')],
      exclusionPatterns: [],
      progressCounter: 1,
      totalAssets: 1,
    });
    const offline = await repo.getById(asset.id);
    expect(offline?.contentChecksum).toBeNull();
  });

  it('retains the accepted limitation after permanent deletion', async () => {
    const file = await makeUpload(temporary, 'deleted-on-nas');
    const first = await upload(file);
    const asset = await setup.ctx.get(AssetRepository).getById(first.id);
    assert(asset);
    await setup.ctx.get(AssetRepository).remove({ id: first.id });
    await unlink(asset.originalPath);
    const repeated = await upload(await makeUpload(temporary, 'deleted-on-nas'));
    expect(repeated.status).toBe(AssetMediaStatus.CREATED);
  });

  it('rejects a destination outside the configured library before publishing files', async () => {
    const outside = join(temporary, 'outside');
    await mkdir(outside);
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', outside);
    await expect(upload(await makeUpload(temporary, 'no-outside-write'))).rejects.toThrow(
      'outside the library import paths',
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it('keeps the normal upload destination for another user', async () => {
    const { user } = await setup.ctx.newUser();
    const file = await makeUpload(temporary, 'another-user');
    const response = await setup.sut.uploadAsset(
      factory.auth({ user: { id: user.id } }),
      {
        fileCreatedAt: new Date(),
        fileModifiedAt: new Date(),
        assetData: Buffer.from('unused'),
      },
      file,
    );
    const asset = await setup.ctx.get(AssetRepository).getById(response.id);
    expect(asset).toMatchObject({
      libraryId: null,
      isExternal: false,
      originalPath: file.originalPath,
      ownerId: user.id,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('falls back to the phone creation time instead of the current upload time', async () => {
    vitest.mocked(setup.ctx.get(MetadataRepository).readTags).mockResolvedValue({});
    const response = await upload(await makeUpload(temporary, 'without-exif'));
    const asset = await setup.ctx.get(AssetRepository).getById(response.id);
    expect(asset?.originalPath).toBe(join(root, '2025/01/IMG_20250101_080000.HEIC'));
  });

  it('rejects new writes before the configured month without creating a historical folder', async () => {
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_MIN_MONTH', '202611');
    vitest
      .mocked(setup.ctx.get(MetadataRepository).readTags)
      .mockResolvedValue({ DateTimeOriginal: ExifDateTime.fromISO('2026-10-31T23:59:59+08:00')! });
    await expect(upload(await makeUpload(temporary, 'old-but-missing'))).rejects.toThrow(
      'Photo predates the configured backup start month',
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('still matches historical files read-only before the backup start month', async () => {
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_MIN_MONTH', '202611');
    const file = await makeUpload(temporary, 'historical-match');
    const { asset } = await setup.ctx.newAsset({
      ownerId: userId,
      libraryId,
      isExternal: true,
      originalPath: file.originalPath,
      contentChecksum: file.checksum,
    });
    const response = await upload(await makeUpload(temporary, 'historical-match'));
    expect(response).toEqual({ id: asset.id, status: AssetMediaStatus.DUPLICATE });
    expect(await readdir(root)).toEqual([]);
    expect(await readFile(file.originalPath, 'utf8')).toBe('historical-match');
  });

  it('blocks target uploads during preparation while leaving other users available', async () => {
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_UPLOADS_ENABLED', 'false');
    await expect(setup.sut.checkIphoneBackupUploadAccess(factory.auth({ user: { id: userId } }))).rejects.toThrow(
      'Photo backup is being prepared',
    );
    const { user } = await setup.ctx.newUser();
    await expect(
      setup.sut.checkIphoneBackupUploadAccess(factory.auth({ user: { id: user.id } })),
    ).resolves.toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps both Live Photo components linked in the same external library', async () => {
    const video = await upload(await makeUpload(temporary, 'motion', 'source.MOV'), {
      visibility: AssetVisibility.Hidden,
    });
    const photo = await upload(await makeUpload(temporary, 'still'), { livePhotoVideoId: video.id });
    const asset = await setup.ctx.get(AssetRepository).getById(photo.id);
    expect(asset).toMatchObject({ libraryId, livePhotoVideoId: video.id });
    const filenames = await readdir(join(root, '2026/11'));
    expect(filenames.sort()).toEqual(['IMG_20261103_111000.HEIC', 'IMG_20261103_111000.MOV']);
  });

  it('rejects symlink escapes before creating a month directory outside the root', async () => {
    const outside = join(temporary, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, '2026'));
    await expect(upload(await makeUpload(temporary, 'symlink'))).rejects.toThrow('escapes the configured root');
    expect(await readdir(outside)).toEqual([]);
  });

  it('removes only its own published file when database side effects fail', async () => {
    setup.ctx.getMock(EventRepository).emit.mockRejectedValueOnce(new Error('Test event failure'));
    await expect(upload(await makeUpload(temporary, 'rollback'))).rejects.toThrow('Test event failure');
    expect(await readdir(join(root, '2026/11'))).toEqual([]);
    const assets = await database.selectFrom('asset').select('id').where('libraryId', '=', libraryId).execute();
    expect(assets).toEqual([]);
  });

  it('distinguishes prechecks from duplicates after receiving the complete file', async () => {
    const file = await makeUpload(temporary, 'audit-proof');
    const created = await upload(file);
    const auth = factory.auth({ user: { id: userId } });
    await setup.sut.getUploadAssetIdByChecksum(auth, file.checksum.toString('base64'));
    await setup.sut.bulkUploadCheck(auth, {
      assets: [{ id: 'opaque-client-id', checksum: file.checksum.toString('base64') }],
    });
    await upload(await makeUpload(temporary, 'audit-proof'));

    // 解析真实服务产生的验收日志，检查阶段和字节数，而不把没有请求误记成客户端跳过。
    const messages = setup.ctx.getMock(LoggingRepository).log.mock.calls.map(([message]) => message);
    const events = messages
      .filter((message) => message.startsWith('IphoneBackupAudit '))
      .map((message) => JSON.parse(message.slice('IphoneBackupAudit '.length)) as Record<string, unknown>);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'upload_received', mediaBytes: file.size, uploadId: file.uuid }),
        expect.objectContaining({ event: 'external_asset_created', assetId: created.id, overwrite: false }),
        expect.objectContaining({ event: 'header_duplicate', assetId: created.id, bodyParsed: false }),
        expect.objectContaining({ event: 'upload_precheck', checked: 1, duplicates: 1 }),
        expect.objectContaining({ event: 'duplicate_after_receive', assetId: created.id, mediaBytes: file.size }),
      ]),
    );
    const auditText = JSON.stringify(events);
    expect(auditText).not.toContain(root);
    expect(auditText).not.toContain(file.originalName);
    expect(auditText).not.toContain(file.checksum.toString('hex'));
  });
});
