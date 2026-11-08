import { schemaFromCode } from '@immich/sql-tools';
import { ExifDateTime } from 'exiftool-vendored';
import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { assert } from 'vitest';
import type { UploadFile } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetMediaCreateDto } from 'src/dtos/asset-media.dto.js';
import { AssetType, AssetVisibility, ChecksumAlgorithm, JobName, SyncRequestType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { IphoneBackupImageRepository } from 'src/repositories/iphone-backup-image.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { DownloadService } from 'src/services/download.service.js';
import { IphoneBackupReferenceService } from 'src/services/iphone-backup-reference.service.js';
import { IphoneBackupSourceService } from 'src/services/iphone-backup-source.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { createIphoneBackupRecovery, restoreIphoneBackupImage } from 'src/utils/iphone-backup-image.js';
import { createIphoneBackupSnapshot, readIphoneBackupSnapshot } from 'src/utils/iphone-backup-snapshot.js';
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
 * @param content 无隐私合成文本或图片字节，不是真实照片。
 * @param originalName 用于检验扩展名和重命名规则的客户端文件名。
 * @returns 完整上传文件描述，调用者的临时目录清理负责释放文件。
 */
async function makeUpload(
  directory: string,
  content: string | Buffer,
  originalName = 'source.HEIC',
): Promise<UploadFile> {
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

/** @param service 当前服务。@returns 唯一明确匹配计划；没有计划就使测试立即失败。 */
async function matched(service: IphoneBackupReferenceService) {
  const rows = await service.assess();
  expect(rows).toHaveLength(1);
  assert(rows[0].status === 'matched', JSON.stringify(rows));
  assert(rows[0].plan);
  return rows[0].plan;
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
    // 下载与动态照片路径判断也使用隔离目录，不读取真实图库的媒体根。
    StorageCore.setMediaLocation(temporary);
    root = join(temporary, 'Photos/MobileBackup/iPhone');
    await mkdir(root, { recursive: true });
    const snapshotRoot = join(temporary, 'snapshots');
    await mkdir(snapshotRoot, { mode: 0o700 });
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT', snapshotRoot);
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
    // 其他用户不使用暂存根，也不要求该目录在他们的上传前已经创建。
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', join(temporary, 'Photos/ReviewNotCreated'));
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

  /** 历史暂存是真实备份：完整原片、侧写、数据库指纹和官方同步保持一致，重试仍去重。 */
  it('stores historical uploads separately and syncs their real checksums without changing archived files', async () => {
    const historicalRoot = join(temporary, 'Photos/UploadReview');
    await mkdir(historicalRoot);
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_MIN_MONTH', '202611');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', historicalRoot);
    vitest
      .mocked(setup.ctx.get(MetadataRepository).readTags)
      .mockResolvedValue({ DateTimeOriginal: ExifDateTime.fromISO('2026-10-31T23:59:59+08:00')! });
    const file = await makeUpload(temporary, 'historical-original', 'source.JPG');
    const sidecar = await makeUpload(temporary, 'historical-sidecar', 'source.xmp');
    const response = await setup.sut.uploadAsset(
      factory.auth({ user: { id: userId } }),
      { fileCreatedAt: new Date('2026-10-31T15:59:59Z'), fileModifiedAt: new Date(), assetData: Buffer.from('unused') },
      file,
      sidecar,
    );
    const destination = join(historicalRoot, '2026/10/IMG_20261031_235959.JPG');
    expect(response.status).toBe(AssetMediaStatus.CREATED);
    expect(await readFile(destination, 'utf8')).toBe('historical-original');
    expect(await readFile(`${destination}.xmp`, 'utf8')).toBe('historical-sidecar');
    expect(await readdir(root)).toEqual([]);
    const asset = await setup.ctx.get(AssetRepository).getById(response.id);
    expect(asset).toMatchObject({
      libraryId,
      originalPath: destination,
      originalFileName: 'source.JPG',
      contentChecksum: file.checksum,
      clientChecksum: file.checksum,
      isExternal: true,
    });
    const sync = new SyncTestContext(database);
    const { session } = await sync.newSession({ userId });
    const events = await sync.syncStream(factory.auth({ user: { id: userId }, session }), [SyncRequestType.AssetsV2]);
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ id: response.id, checksum: file.checksum.toString('base64') }),
      }),
    );
    expect(await upload(await makeUpload(temporary, 'historical-original', 'renamed.JPG'))).toEqual({
      id: response.id,
      status: AssetMediaStatus.DUPLICATE,
    });
    expect(await readdir(join(historicalRoot, '2026/10'))).toHaveLength(2);
    // 移除配置仅恢复后续历史写入门禁；已存在的真实资产与原片不受影响。
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', undefined);
    await expect(upload(await makeUpload(temporary, 'another-historical-file'))).rejects.toThrow(
      'Photo predates the configured backup start month',
    );
    expect(await readFile(destination, 'utf8')).toBe('historical-original');
    expect(
      await setup.sut.getUploadAssetIdByChecksum(
        factory.auth({ user: { id: userId } }),
        file.checksum.toString('base64'),
      ),
    ).toEqual({ id: response.id, status: AssetMediaStatus.DUPLICATE });
  });

  /** 当前月份仍走原归档目录，配置暂存不会把正常备份混入诊断目录。 */
  it('keeps current-month uploads in the normal root when historical staging is enabled', async () => {
    const historicalRoot = join(temporary, 'Photos/UploadReview');
    await mkdir(historicalRoot);
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_MIN_MONTH', '202611');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', historicalRoot);
    const response = await upload(await makeUpload(temporary, 'current-original'));
    const asset = await setup.ctx.get(AssetRepository).getById(response.id);
    expect(asset?.originalPath).toBe(join(root, '2026/11/IMG_20261103_111000.HEIC'));
    expect(await readdir(historicalRoot)).toEqual([]);
  });

  /** 同秒历史上传使用既有原子发布和后缀规则，两份内容都必须完整保留。 */
  it('preserves distinct historical uploads captured in the same second', async () => {
    const historicalRoot = join(temporary, 'Photos/UploadReview');
    await mkdir(historicalRoot);
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_MIN_MONTH', '202611');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', historicalRoot);
    vitest
      .mocked(setup.ctx.get(MetadataRepository).readTags)
      .mockResolvedValue({ DateTimeOriginal: ExifDateTime.fromISO('2026-09-26T15:47:41+08:00')! });
    const first = await upload(await makeUpload(temporary, 'historical-burst-one', 'first.JPG'));
    const second = await upload(await makeUpload(temporary, 'historical-burst-two', 'second.JPG'));
    expect(first.id).not.toBe(second.id);
    const directory = join(historicalRoot, '2026/09');
    expect(await readFile(join(directory, 'IMG_20260926_154741.JPG'), 'utf8')).toBe('historical-burst-one');
    expect(await readFile(join(directory, 'IMG_20260926_154741+1.JPG'), 'utf8')).toBe('historical-burst-two');
    expect(await readdir(root)).toEqual([]);
  });

  /** 暂存根仍须属于目标库，不能通过配置或根符号链接写入其他位置。 */
  it('rejects historical roots outside the library or resolving into the normal root', async () => {
    const outside = join(temporary, 'outside-review');
    await mkdir(outside);
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', outside);
    await expect(upload(await makeUpload(temporary, 'outside-review-write'))).rejects.toThrow(
      'outside the library import paths',
    );
    expect(await readdir(outside)).toEqual([]);
    const alias = join(temporary, 'Photos/ReviewAlias');
    await symlink(root, alias);
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', alias);
    await expect(upload(await makeUpload(temporary, 'alias-review-write'))).rejects.toThrow(
      'historical backup root overlaps',
    );
    expect(await readdir(root)).toEqual([]);
  });

  /** 暂存目录的年月子目录仍逐层校验，符号链接不能绕过导入范围限制。 */
  it('rejects a historical month symlink escaping the staging root', async () => {
    const historicalRoot = join(temporary, 'Photos/UploadReview');
    const outside = join(temporary, 'outside-month');
    await mkdir(join(historicalRoot, '2026'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(historicalRoot, '2026/10'));
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_MIN_MONTH', '202611');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', historicalRoot);
    vitest
      .mocked(setup.ctx.get(MetadataRepository).readTags)
      .mockResolvedValue({ DateTimeOriginal: ExifDateTime.fromISO('2026-10-31T23:59:59+08:00')! });
    await expect(upload(await makeUpload(temporary, 'escaped-review-write'))).rejects.toThrow(
      'destination escapes the configured root',
    );
    expect(await readdir(outside)).toEqual([]);
  });

  /** 建档失败时清除本次暂存发布，不能把未成功备份的文件伪装为已接收。 */
  it('rolls back staged historical files when asset creation fails', async () => {
    const historicalRoot = join(temporary, 'Photos/UploadReview');
    await mkdir(historicalRoot);
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_MIN_MONTH', '202611');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', historicalRoot);
    vitest
      .mocked(setup.ctx.get(MetadataRepository).readTags)
      .mockResolvedValue({ DateTimeOriginal: ExifDateTime.fromISO('2026-10-31T23:59:59+08:00')! });
    vitest.spyOn(setup.ctx.get(AssetRepository), 'create').mockRejectedValueOnce(new Error('Synthetic create failure'));
    await expect(upload(await makeUpload(temporary, 'failed-review-write'))).rejects.toThrow(
      'Synthetic create failure',
    );
    expect(await readdir(join(historicalRoot, '2026/10'))).toEqual([]);
    expect(await readdir(root)).toEqual([]);
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

  /** 照片模式的发布防线拒绝完整暂存的视频并安排清理，但仍允许静态照片建档。 */
  it('rejects videos without publishing while still accepting photos in photos-only mode', async () => {
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_VIDEOS_ENABLED', 'false');
    const video = await makeUpload(temporary, 'motion-not-published', 'source.MOV');
    await expect(upload(video)).rejects.toMatchObject({ status: 503 });
    expect(await readdir(root)).toEqual([]);
    expect(setup.ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
      name: JobName.FileDelete,
      data: { files: [video.originalPath, undefined] },
    });
    expect(await database.selectFrom('asset').select('id').where('ownerId', '=', userId).execute()).toEqual([]);

    const photo = await upload(await makeUpload(temporary, 'still-published'));
    expect(await setup.ctx.get(AssetRepository).getById(photo.id)).toMatchObject({ libraryId });
    expect(await readdir(join(root, '2026/11'))).toEqual(['IMG_20261103_111000.HEIC']);
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

  /**
   * 建立不同元数据的合成 JPEG/PNG 对及真实外部资产。
   * @param differentImage 为 true 时替换像素，模拟同秒连拍。
   * @param format 测试实际编码格式，文件名和数据库名称与编码保持一致。
   * @returns 实际文件和数据库记录；由外层临时目录清理回收。
   */
  async function pair(differentImage = false, format: 'jpeg' | 'png' = 'jpeg') {
    const historicalRoot = join(temporary, 'Photos/Review');
    await mkdir(historicalRoot, { recursive: true });
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', historicalRoot);
    const extension = format === 'png' ? 'PNG' : 'JPG';
    const stagedPath = join(historicalRoot, `phone.${extension}`);
    const sourcePath = join(root, `nas.${extension}`);
    const pixels = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#225599' } })
      .toFormat(format)
      .toBuffer();
    await writeFile(stagedPath, pixels);
    await writeFile(
      sourcePath,
      differentImage
        ? await sharp({ create: { width: 24, height: 16, channels: 3, background: '#993322' } })
            .toFormat(format)
            .toBuffer()
        : pixels,
    );
    await setup.ctx.get(MetadataRepository).writeTags(sourcePath, { Keywords: ['shared'], Subject: ['shared'] });
    const sourceBytes = await readFile(sourcePath);
    const source = await setup.ctx.newAsset({
      ownerId: userId,
      libraryId,
      originalPath: sourcePath,
      originalFileName: `nas.${extension}`,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${sourcePath}`).digest(),
      contentChecksum: createHash('sha1').update(sourceBytes).digest(),
    });
    const version = await setup.ctx.newAsset({
      ownerId: userId,
      libraryId,
      originalPath: stagedPath,
      originalFileName: `phone.${extension}`,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${stagedPath}`).digest(),
      contentChecksum: createHash('sha1').update(pixels).digest(),
      fileCreatedAt: source.result.fileCreatedAt,
    });
    const service = new IphoneBackupReferenceService(database, setup.ctx.get(MetadataRepository));
    return { source: source.result, version: version.result, pixels, sourceBytes, sourcePath, stagedPath, service };
  }

  /** @returns 用真实同步协议确认当前资产和同步完成事件的手机会话。 */
  async function acknowledge() {
    const sync = new SyncTestContext(database);
    const { session } = await sync.newSession({ userId });
    const auth = factory.auth({ user: { id: userId }, session });
    const events = await sync.syncStream(auth, [SyncRequestType.AssetsV2]);
    await sync.sut.setAcks(auth, { acks: events.map((event) => event.ack) });
    return { session, auth, events, sync };
  }

  /** @param p 当前真实合成文件对。@returns 与可信接收上传相同的自有不可变底稿和初始来源记录。 */
  async function protectUploadedVersion(p: Awaited<ReturnType<typeof pair>>) {
    const repository = new IphoneBackupImageRepository(database);
    const checksum = createHash('sha1').update(p.pixels).digest();
    const snapshot = await createIphoneBackupSnapshot({
      root: process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT!,
      sourceId: p.version.id,
      sourcePath: p.stagedPath,
      checksum: checksum.toString('hex'),
    });
    await repository.recordSnapshot({
      sourceId: p.version.id,
      ownerId: userId,
      libraryId,
      sourcePath: p.stagedPath,
      checksum,
      path: snapshot.path,
      signature: snapshot.signature,
    });
    const origin = await repository.captureUpload({
      assetId: p.version.id,
      ownerId: userId,
      libraryId,
      originalPath: p.stagedPath,
      checksum,
      recovery: createIphoneBackupRecovery(p.pixels, p.pixels),
      snapshot: {
        originalFileName: p.version.originalFileName,
        fileCreatedAt: new Date(p.version.fileCreatedAt).toISOString(),
        fileModifiedAt: new Date(p.version.fileModifiedAt).toISOString(),
        type: p.version.type,
        isFavorite: p.version.isFavorite,
        visibility: p.version.visibility,
        livePhotoVideoId: p.version.livePhotoVideoId,
        duration: p.version.duration,
      },
    });
    return { repository, checksum, snapshot, origin };
  }

  /** 用真实 JPEG、ExifTool、文件系统和数据库贯通版本关联及清理后的官方同步。 */
  describe('metadata-equivalent backup references', () => {
    /** 精确释放 A 的当前自有副本；B pin、A 的其他旧版本、身份和可恢复原始字节均保留。 */
    it('removes only the acknowledged trusted upload self snapshot and keeps exact downloads', async () => {
      const p = await pair();
      const own = await protectUploadedVersion(p);
      const oldPath = join(temporary, 'previous-version.jpg');
      const oldBytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#889922' } })
        .jpeg()
        .toBuffer();
      await writeFile(oldPath, oldBytes);
      const old = await createIphoneBackupSnapshot({
        root: process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT!,
        sourceId: p.version.id,
        sourcePath: oldPath,
        checksum: createHash('sha1').update(oldBytes).digest('hex'),
      });
      await database
        .insertInto('fork_iphone_source_snapshot')
        .values({
          sourceId: p.version.id,
          checksum: Buffer.from(old.checksum, 'hex'),
          path: old.path,
          signature: old.signature,
        })
        .execute();
      await p.service.prepare(await matched(p.service));
      const before = await setup.ctx.get(AssetRepository).getById(p.version.id);
      assert(before);
      const pinned = await own.repository.getSnapshot(p.source.id, createHash('sha1').update(p.sourceBytes).digest());
      assert(pinned);
      const { session, auth } = await acknowledge();
      await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('cleaned');
      await expect(readFile(p.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(own.snapshot.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeUndefined();
      expect(await readFile(pinned.path)).toEqual(p.sourceBytes);
      expect(await readFile(old.path)).toEqual(oldBytes);
      expect(await own.repository.getUpload(p.version.id)).toEqual(own.origin);
      expect(await setup.ctx.get(AssetRepository).getById(p.version.id)).toMatchObject({
        id: before.id,
        clientChecksum: before.clientChecksum,
        backupChecksum: before.backupChecksum,
        backupSourceId: before.backupSourceId,
        backupMetadata: before.backupMetadata,
        livePhotoVideoId: before.livePhotoVideoId,
        stackId: before.stackId,
        updateId: before.updateId,
      });
      const download = await setup.sut.downloadOriginal(auth, p.version.id, {});
      try {
        expect(await readFile(download.path)).toEqual(p.pixels);
      } finally {
        await download.onComplete?.();
      }
    });

    /** stage 已删也必须继续处理精确自有底稿；全部清理后的再执行保持幂等。 */
    it('collects a redundant self snapshot when staging is already absent', async () => {
      const p = await pair();
      const own = await protectUploadedVersion(p);
      await p.service.prepare(await matched(p.service));
      const { session } = await acknowledge();
      await unlink(p.stagedPath);
      await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('absent');
      await expect(readFile(own.snapshot.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeUndefined();
      await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('absent');
    });

    /** 缺失 stage 不能绕过手机确认或实际 B pin 的完整恢复证明。 */
    it.each(['ack', 'missing-pin', 'corrupt-pin'])(
      'keeps the self snapshot with absent staging when the required proof fails: %s',
      async (failure) => {
        const p = await pair();
        const own = await protectUploadedVersion(p);
        await p.service.prepare(await matched(p.service));
        const { session } = await acknowledge();
        const pinned = await own.repository.getSnapshot(p.source.id, createHash('sha1').update(p.sourceBytes).digest());
        assert(pinned);
        if (failure === 'ack') {
          await database.deleteFrom('session_sync_checkpoint').where('sessionId', '=', session.id).execute();
        } else if (failure === 'missing-pin') {
          await unlink(pinned.path);
        } else {
          await writeFile(pinned.path, Buffer.from('corrupt-synthetic-pin'));
        }
        await unlink(p.stagedPath);
        await expect(p.service.cleanup(p.version.id, session.id)).rejects.toThrow();
        expect(await readFile(own.snapshot.path)).toEqual(p.pixels);
        expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeDefined();
      },
    );

    /** 文件删除不随 SQL 回滚恢复；重试清理或回退均须安全处理遗留的缺失文件记录。 */
    it.each(['cleanup', 'restore'])('recovers from rollback after self unlink using %s', async (retry) => {
      const p = await pair();
      const own = await protectUploadedVersion(p);
      await p.service.prepare(await matched(p.service));
      const { session } = await acknowledge();
      const fail = vitest
        .spyOn(IphoneBackupImageRepository.prototype, 'deleteRedundantUploadSnapshot')
        .mockRejectedValueOnce(new Error('Synthetic snapshot delete transaction failure'));
      try {
        await expect(p.service.cleanup(p.version.id, session.id)).rejects.toThrow('Synthetic snapshot delete');
      } finally {
        fail.mockRestore();
      }
      await expect(readFile(p.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(own.snapshot.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeDefined();
      const referenced = await setup.ctx.get(AssetRepository).getById(p.version.id);
      expect(referenced?.backupSourceId).toBe(p.source.id);
      if (retry === 'cleanup') {
        await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('absent');
        expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeUndefined();
      } else {
        await expect(p.service.restore(p.version.id)).resolves.toBe('restored');
        const rebuilt = await own.repository.getSnapshot(p.version.id, own.checksum);
        assert(rebuilt);
        const current = await lstat(rebuilt.path, { bigint: true });
        expect(rebuilt.signature).toBe(
          `${current.dev}:${current.ino}:${current.size}:${current.mtimeNs}:${current.ctimeNs}`,
        );
        expect(
          await readIphoneBackupSnapshot({
            root: process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT!,
            path: rebuilt.path,
            checksum: own.checksum.toString('hex'),
          }),
        ).toEqual(p.pixels);
        expect(await readFile(p.stagedPath)).toEqual(p.pixels);
      }
      expect(await own.repository.getUpload(p.version.id)).toEqual(own.origin);
    });

    /** 其他快照行共享自有路径时，必须在第一次 unlink 前拒绝，不能删掉仍有名字依赖的文件。 */
    it('refuses a self snapshot path shared by another snapshot record', async () => {
      const p = await pair();
      const own = await protectUploadedVersion(p);
      await p.service.prepare(await matched(p.service));
      const other = await setup.ctx.newAsset({ ownerId: userId, libraryId, originalPath: join(root, 'other.jpg') });
      await database
        .insertInto('fork_iphone_source_snapshot')
        .values({
          sourceId: other.result.id,
          checksum: own.checksum,
          path: own.snapshot.path,
          signature: own.snapshot.signature,
        })
        .execute();
      const { session } = await acknowledge();
      await expect(p.service.cleanup(p.version.id, session.id)).rejects.toThrow('still referenced');
      expect(await readFile(p.stagedPath)).toEqual(p.pixels);
      expect(await readFile(own.snapshot.path)).toEqual(p.pixels);
    });

    /** 来源 UUID 错误、符号链接和损坏自有文件均不能在删除 stage 后才暴露。 */
    it.each(['wrong-id', 'symlink', 'corrupt', 'dangling-stage'])(
      'rejects an unsafe redundant snapshot or staging path before deleting any file: %s',
      async (failure) => {
        const p = await pair();
        const own = await protectUploadedVersion(p);
        await p.service.prepare(await matched(p.service));
        switch (failure) {
          case 'wrong-id': {
            const other = await createIphoneBackupSnapshot({
              root: process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT!,
              sourceId: p.source.id,
              sourcePath: p.stagedPath,
              checksum: own.checksum.toString('hex'),
            });
            await database
              .updateTable('fork_iphone_source_snapshot')
              .set({ path: other.path, signature: other.signature })
              .where('sourceId', '=', p.version.id)
              .where('checksum', '=', own.checksum)
              .execute();
            break;
          }
          case 'symlink': {
            await rename(own.snapshot.path, `${own.snapshot.path}.saved`);
            await symlink(`${own.snapshot.path}.saved`, own.snapshot.path);
            break;
          }
          case 'corrupt': {
            await writeFile(own.snapshot.path, Buffer.from('corrupt-synthetic-self-snapshot'));
            break;
          }
          default: {
            await unlink(p.stagedPath);
            await symlink(join(temporary, 'missing-synthetic-target'), p.stagedPath);
          }
        }
        const { session } = await acknowledge();
        await expect(p.service.cleanup(p.version.id, session.id)).rejects.toThrow();
        expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeDefined();
        if (failure === 'dangling-stage') {
          const stage = await lstat(p.stagedPath);
          expect(stage.isSymbolicLink()).toBe(true);
        } else {
          expect(await readFile(p.stagedPath)).toEqual(p.pixels);
        }
        expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
      },
    );

    /** 基线登记失败必须保留旧引用；重试只能复用已完整验证的新文件，不能提交半恢复资产。 */
    it('rolls back a restore whose new independent baseline could not be recorded', async () => {
      const p = await pair();
      const own = await protectUploadedVersion(p);
      await p.service.prepare(await matched(p.service));
      const { session } = await acknowledge();
      await p.service.cleanup(p.version.id, session.id);
      const fail = vitest
        .spyOn(IphoneBackupImageRepository.prototype, 'recordSnapshot')
        .mockRejectedValueOnce(new Error('Synthetic restored snapshot record failure'));
      try {
        await expect(p.service.restore(p.version.id)).rejects.toThrow('Synthetic restored snapshot');
      } finally {
        fail.mockRestore();
      }
      const referenced = await setup.ctx.get(AssetRepository).getById(p.version.id);
      expect(referenced?.backupSourceId).toBe(p.source.id);
      expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeUndefined();
      await expect(p.service.restore(p.version.id)).resolves.toBe('restored');
      expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeDefined();
      expect(await readFile(p.stagedPath)).toEqual(p.pixels);
    });

    /** 回收再回退后，普通上传仍有初始底稿；NAS 改 EXIF 时无需手机重传即可恢复旧手机完整版本。 */
    it('preserves the original phone identity after self snapshot cleanup, restore and later NAS metadata edits', async () => {
      const p = await pair();
      const uploadedPath = join(root, 'phone-upload.JPG');
      await rename(p.stagedPath, uploadedPath);
      p.stagedPath = uploadedPath;
      await database
        .updateTable('asset')
        .set({ originalPath: uploadedPath, checksum: createHash('sha1').update(`path:${uploadedPath}`).digest() })
        .where('id', '=', p.version.id)
        .execute();
      const own = await protectUploadedVersion(p);
      await p.service.prepare(await matched(p.service));
      const { session } = await acknowledge();
      await p.service.cleanup(p.version.id, session.id);
      expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeUndefined();
      await expect(p.service.restore(p.version.id)).resolves.toBe('restored');
      const restored = await own.repository.getSnapshot(p.version.id, own.checksum);
      assert(restored);
      expect(await readFile(restored.path)).toEqual(p.pixels);
      const metadata = setup.ctx.get(MetadataRepository);
      await metadata.writeTags(uploadedPath, {
        Keywords: ['shared', 'calibrated'],
        DateTimeOriginal: ExifDateTime.fromISO('2026-09-03T10:20:30+08:00'),
        GPSLatitude: 22.5,
        GPSLongitude: 113.8,
      });
      const changed = await readFile(uploadedPath);
      expect(changed).not.toEqual(p.pixels);
      const refresh = await new IphoneBackupSourceService(database, metadata).refreshSource(p.version.id);
      expect(refresh.recoveredAssetId).toBeDefined();
      const original = await setup.ctx.get(AssetRepository).getById(refresh.recoveredAssetId!);
      assert(original);
      expect(await readFile(original.originalPath)).toEqual(p.pixels);
      expect(original.clientChecksum).toEqual(own.checksum);
      expect(await readFile(uploadedPath)).toEqual(changed);
      expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
      const origin = await own.repository.getUpload(p.version.id);
      expect(origin?.recoveredAssetId).toBe(original.id);
      const again = await new IphoneBackupSourceService(database, metadata).refreshSource(p.version.id);
      expect(again.recoveredAssetId).toBe(original.id);
    });

    /** 已有自有底稿不得绕过恢复路径校验；回收前后都拒绝最终链接和库内父目录别名。 */
    it.each([
      { failure: 'final-symlink', collected: false },
      { failure: 'final-symlink', collected: true },
      { failure: 'parent-alias', collected: false },
      { failure: 'parent-alias', collected: true },
    ])(
      'rejects an unsafe restore path before removing the reference: $failure/$collected',
      async ({ failure, collected }) => {
        const p = await pair();
        const review = process.env.IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT!;
        const parent = join(review, 'nested');
        await mkdir(parent);
        const nestedPath = join(parent, 'phone.JPG');
        await rename(p.stagedPath, nestedPath);
        p.stagedPath = nestedPath;
        await database
          .updateTable('asset')
          .set({ originalPath: nestedPath, checksum: createHash('sha1').update(`path:${nestedPath}`).digest() })
          .where('id', '=', p.version.id)
          .execute();
        const own = await protectUploadedVersion(p);
        await p.service.prepare(await matched(p.service));
        const before = await setup.ctx.get(AssetRepository).getById(p.version.id);
        if (collected) {
          const { session } = await acknowledge();
          await p.service.cleanup(p.version.id, session.id);
          expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeUndefined();
        } else {
          await unlink(p.stagedPath);
        }
        let untouched: string;
        if (failure === 'final-symlink') {
          untouched = join(temporary, 'untouched-original.JPG');
          await writeFile(untouched, p.pixels);
          await symlink(untouched, p.stagedPath);
        } else {
          const actual = join(review, 'actual');
          await rename(parent, actual);
          await symlink(actual, parent);
          untouched = join(actual, 'phone.JPG');
          await writeFile(untouched, p.pixels);
        }
        await expect(p.service.restore(p.version.id)).rejects.toThrow('Unsafe');
        expect(await readFile(untouched)).toEqual(p.pixels);
        expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
        expect(await setup.ctx.get(AssetRepository).getById(p.version.id)).toMatchObject({
          backupSourceId: before?.backupSourceId,
          backupChecksum: before?.backupChecksum,
          clientChecksum: before?.clientChecksum,
        });
        expect(!!(await own.repository.getSnapshot(p.version.id, own.checksum))).toBe(!collected);
      },
    );

    /** 同一个完整摘要属于不同 UUID 时也不能按摘要删除 B pin；只释放 A 的精确键。 */
    it('keeps the source pin when both asset ids have the same complete checksum', async () => {
      const p = await pair();
      await writeFile(p.sourcePath, p.pixels);
      await database
        .updateTable('asset')
        .set({ contentChecksum: createHash('sha1').update(p.pixels).digest() })
        .where('id', '=', p.source.id)
        .execute();
      const own = await protectUploadedVersion(p);
      await p.service.prepare(await matched(p.service));
      const pinned = await own.repository.getSnapshot(p.source.id, own.checksum);
      assert(pinned);
      const { session } = await acknowledge();
      await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('cleaned');
      expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeUndefined();
      expect(await own.repository.getSnapshot(p.source.id, own.checksum)).toBeDefined();
      expect(await readFile(pinned.path)).toEqual(p.pixels);
      expect(await readFile(p.sourcePath)).toEqual(p.pixels);
    });

    /** 无可信接收凭据的旧历史版本可清理 stage，但优化不能触碰其已有自有底稿。 */
    it('preserves an unproven self snapshot while retaining legacy staging cleanup', async () => {
      const p = await pair();
      const own = await protectUploadedVersion(p);
      await database.deleteFrom('fork_iphone_upload_origin').where('assetId', '=', p.version.id).execute();
      await p.service.prepare(await matched(p.service));
      const { session } = await acknowledge();
      await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('cleaned');
      expect(await readFile(own.snapshot.path)).toEqual(p.pixels);
      expect(await own.repository.getSnapshot(p.version.id, own.checksum)).toBeDefined();
    });

    /** 日期偏差数月仍能复用已有向量找回同图，最终依据真实文件的无损恢复而非相似度。 */
    it('finds exact originals through existing vectors when recorded dates differ', async () => {
      const p = await pair();
      const embedding = JSON.stringify([1, ...Array.from({ length: 511 }, () => 0)]);
      await database
        .updateTable('asset')
        .set({ fileCreatedAt: new Date(+new Date(p.source.fileCreatedAt) + 120 * 86_400_000) })
        .where('id', '=', p.source.id)
        .execute();
      await database
        .insertInto('smart_search')
        .values([
          { assetId: p.source.id, embedding },
          { assetId: p.version.id, embedding },
        ])
        .execute();
      await p.service.prepare(await matched(p.service));
      const { session } = await acknowledge();
      await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('cleaned');
      await p.service.restore(p.version.id);
      expect(await readFile(p.stagedPath)).toEqual(p.pixels);
      expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
    });

    /** 即使视觉向量完全相同，不同连拍的实际编码仍必须拒绝，不能把 ANN 候选当作备份证明。 */
    it('rejects a wrong image even when its vector exactly matches', async () => {
      const p = await pair(true);
      const embedding = JSON.stringify([1, ...Array.from({ length: 511 }, () => 0)]);
      await database
        .updateTable('asset')
        .set({ fileCreatedAt: new Date(+new Date(p.source.fileCreatedAt) + 120 * 86_400_000) })
        .where('id', '=', p.source.id)
        .execute();
      await database
        .insertInto('smart_search')
        .values([
          { assetId: p.source.id, embedding },
          { assetId: p.version.id, embedding },
        ])
        .execute();
      expect(await p.service.assess()).toEqual([{ id: p.version.id, status: 'unmatched', plan: undefined }]);
      expect(await readFile(p.stagedPath)).toEqual(p.pixels);
      expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
    });

    /** PNG 删除完整副本后仍能提供正确 MIME/文件名和原始字节，并可回退成独立原片。 */
    it('restores exact PNG downloads with the original content type and filename', async () => {
      const p = await pair(false, 'png');
      await p.service.prepare(await matched(p.service));
      const { session, auth } = await acknowledge();
      await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('cleaned');
      const download = await setup.sut.downloadOriginal(auth, p.version.id, {});
      try {
        expect(download.contentType).toBe('image/png');
        expect(download.fileName).toBe('phone.PNG');
        expect(await readFile(download.path)).toEqual(p.pixels);
      } finally {
        await download.onComplete?.();
      }
      await expect(p.service.restore(p.version.id)).resolves.toBe('restored');
      expect(await readFile(p.stagedPath)).toEqual(p.pixels);
      expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
    });

    /** 照片静态部分共用时保留各自的视频关联；相同或不同的视频都不能被替换或清理。 */
    it.each([true, false])('preserves Live Photo motion links when shared motion is %s', async (sameMotion) => {
      const p = await pair();
      const sourceMotionPath = join(root, 'source-motion.MOV');
      const versionMotionPath = join(root, 'version-motion.MOV');
      const sourceBytes = Buffer.from('synthetic-source-motion');
      const versionBytes = sameMotion ? sourceBytes : Buffer.from('synthetic-version-motion');
      await writeFile(sourceMotionPath, sourceBytes);
      await writeFile(versionMotionPath, versionBytes);
      const sourceMotion = await setup.ctx.newAsset({
        ownerId: userId,
        libraryId,
        isExternal: true,
        type: AssetType.Video,
        originalPath: sourceMotionPath,
        originalFileName: 'source-motion.MOV',
      });
      const versionMotion = sameMotion
        ? sourceMotion
        : await setup.ctx.newAsset({
            ownerId: userId,
            libraryId,
            isExternal: true,
            type: AssetType.Video,
            originalPath: versionMotionPath,
            originalFileName: 'version-motion.MOV',
          });
      const repo = setup.ctx.get(AssetRepository);
      await repo.upsertExif({
        exif: { assetId: p.version.id, fileSizeInByte: p.pixels.length },
        lockedPropertiesBehavior: 'skip',
      });
      await repo.upsertExif({
        exif: { assetId: sourceMotion.result.id, fileSizeInByte: sourceBytes.length },
        lockedPropertiesBehavior: 'skip',
      });
      await repo.upsertExif({
        exif: { assetId: versionMotion.result.id, fileSizeInByte: versionBytes.length },
        lockedPropertiesBehavior: 'skip',
      });
      await repo.update({ id: p.source.id, livePhotoVideoId: sourceMotion.result.id });
      await repo.update({ id: p.version.id, livePhotoVideoId: versionMotion.result.id });
      await p.service.prepare(await matched(p.service));
      const { session, auth } = await acknowledge();
      await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('cleaned');
      const version = await repo.getById(p.version.id);
      const source = await repo.getById(p.source.id);
      expect(version?.livePhotoVideoId).toBe(versionMotion.result.id);
      expect(source?.livePhotoVideoId).toBe(sourceMotion.result.id);
      const archiveService = newMediumService(DownloadService, {
        database,
        real: [AccessRepository, AssetRepository, DownloadRepository, StorageRepository, UserRepository],
        mock: [LoggingRepository],
      });
      const archive = await archiveService.sut.getDownloadInfo(auth, { assetIds: [p.version.id] });
      const downloadIds = archive.archives.flatMap((entry) => entry.assetIds);
      expect(downloadIds).toContain(versionMotion.result.id);
      if (!sameMotion) expect(downloadIds).not.toContain(sourceMotion.result.id);
      const zipped = await archiveService.sut.downloadArchive(auth, { assetIds: downloadIds });
      const chunks: Buffer[] = [];
      for await (const chunk of zipped.stream) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(bytes.includes(p.pixels)).toBe(true);
      expect(bytes.includes(versionBytes)).toBe(true);
      if (!sameMotion) expect(bytes.includes(sourceBytes)).toBe(false);
      const download = await setup.sut.downloadOriginal(auth, p.version.id, {});
      try {
        expect(await readFile(download.path)).toEqual(p.pixels);
      } finally {
        await download.onComplete?.();
      }
      expect(await readFile(sourceMotionPath)).toEqual(sourceBytes);
      expect(await readFile(versionMotionPath)).toEqual(versionBytes);
      expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
    });

    /** 即使完整副本已经清理，仍可先还原文件再撤销引用，保证有实际可执行的回退路径。 */
    it('restores an independent original before removing its reference', async () => {
      const p = await pair();
      await p.service.prepare(await matched(p.service));
      const { session } = await acknowledge();
      await p.service.cleanup(p.version.id, session.id);
      expect(await p.service.restore(p.version.id)).toBe('restored');
      expect(await p.service.restore(p.version.id)).toBe('not-referenced');
      expect(await readFile(p.stagedPath)).toEqual(p.pixels);
      expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
      expect(await setup.ctx.get(AssetRepository).getById(p.version.id)).toMatchObject({
        originalPath: p.stagedPath,
        backupChecksum: null,
        backupSourceId: null,
      });
    });
    /** 清理后重新建服务和远端索引，两种整文件哈希仍对应独立资产；原片只保留一份。 */
    it('keeps both phone identities after cleanup, restart, fresh sync and upload retry', async () => {
      const p = await pair();
      const plan = await matched(p.service);
      await p.service.prepare(plan);
      await expect(readFile(p.stagedPath)).resolves.toEqual(p.pixels);
      const first = new SyncTestContext(database);
      const { session: noAck } = await first.newSession({ userId });
      await expect(p.service.cleanup(p.version.id, noAck.id)).rejects.toThrow('Phone must acknowledge');
      const { session } = await acknowledge();
      await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('cleaned');
      await expect(readFile(p.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
      const restarted = new IphoneBackupReferenceService(database, setup.ctx.get(MetadataRepository));
      await expect(restarted.cleanup(p.version.id, session.id)).resolves.toBe('absent');
      const { events } = await acknowledge();
      // 使用官方客户端依赖的唯一约束和 SHA-1 关联方式，验证两个手机版本能同时算作已备份。
      const phoneIndex = new DatabaseSync(':memory:');
      try {
        phoneIndex.exec(
          'CREATE TABLE remote (id TEXT PRIMARY KEY, library TEXT, checksum TEXT, UNIQUE(library,checksum)); CREATE TABLE local (checksum TEXT);',
        );
        for (const event of events) {
          if (event.type !== 'AssetV2') {
            continue;
          }

          const row = event.data as { id: string; libraryId: string; checksum: string };
          phoneIndex.prepare('INSERT INTO remote VALUES (?,?,?)').run(row.id, row.libraryId, row.checksum);
        }
        for (const asset of [p.source, p.version])
          phoneIndex.prepare('INSERT INTO local VALUES (?)').run(asset.contentChecksum!.toString('base64'));
        expect(
          phoneIndex.prepare('SELECT COUNT(*) AS matched FROM local JOIN remote USING(checksum)').get(),
        ).toMatchObject({ matched: 2 });
      } finally {
        phoneIndex.close();
      }
      for (const asset of [p.source, p.version]) {
        expect(events).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ id: asset.id, checksum: asset.contentChecksum!.toString('base64') }),
          }),
        );
        expect(
          await setup.sut.getUploadAssetIdByChecksum(
            factory.auth({ user: { id: userId } }),
            asset.contentChecksum!.toString('base64'),
          ),
        ).toEqual({ id: asset.id, status: AssetMediaStatus.DUPLICATE });
      }
      expect(await upload(await makeUpload(temporary, p.pixels, 'retry.JPG'))).toEqual({
        id: p.version.id,
        status: AssetMediaStatus.DUPLICATE,
      });
      const original = await setup.ctx.get(AssetRepository).getForOriginal(p.version.id, false);
      expect(original.originalPath).not.toBe(p.sourcePath);
      expect(await readFile(original.originalPath)).toEqual(p.sourceBytes);
      // 原片下载应逐字节还原手机版本，不以元数据等价为由改变下载 API 的校验和语义。
      const downloaded = await setup.sut.downloadOriginal(factory.auth({ user: { id: userId } }), p.version.id, {});
      expect(await readFile(downloaded.path)).toEqual(p.pixels);
      await downloaded.onComplete?.();
      await expect(readFile(downloaded.path)).rejects.toMatchObject({ code: 'ENOENT' });
      const archiveService = newMediumService(DownloadService, {
        database,
        real: [AccessRepository, AssetRepository, StorageRepository],
        mock: [LoggingRepository],
      });
      const archive = await archiveService.sut.downloadArchive(factory.auth({ user: { id: userId } }), {
        assetIds: [p.version.id],
      });
      const chunks: Buffer[] = [];
      for await (const chunk of archive.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).includes(p.pixels)).toBe(true);
      expect(await setup.ctx.get(AssetRepository).getByLibraryIdAndOriginalPath(libraryId, p.sourcePath)).toMatchObject(
        { id: p.source.id },
      );
    });

    /** 图像不同的同秒候选不能改成引用或进入清理阶段。 */
    it('preserves a different burst image', async () => {
      const p = await pair(true);
      expect(await p.service.assess()).toEqual([{ id: p.version.id, status: 'unmatched', plan: undefined }]);
      expect(await readFile(p.stagedPath)).toEqual(p.pixels);
    });

    /** 评分、方向、描述和标签不同仍是独立版本；共用编码图像后必须能恢复完整手机版本。 */
    it('preserves meaningful metadata differences in separate recoverable versions', async () => {
      const p = await pair();
      await setup.ctx.get(MetadataRepository).writeTags(p.sourcePath, { Keywords: ['shared', 'important'], Rating: 5 });
      await setup.ctx.get(MetadataRepository).writeTags(p.stagedPath, {
        Keywords: ['phone-only'],
        Rating: 4,
        Orientation: 3,
        Description: 'Synthetic phone description',
        GPSLatitude: 22.33,
        GPSLongitude: 114.1,
      });
      const phoneBytes = await readFile(p.stagedPath);
      const sourceBytes = await readFile(p.sourcePath);
      await setup.ctx.get(AssetRepository).update({
        id: p.source.id,
        contentChecksum: createHash('sha1').update(sourceBytes).digest(),
      });
      const phoneChecksum = createHash('sha1').update(phoneBytes).digest();
      await setup.ctx.get(AssetRepository).update({ id: p.version.id, contentChecksum: phoneChecksum });
      await p.service.prepare(await matched(p.service));
      const { session } = await acknowledge();
      await expect(p.service.cleanup(p.version.id, session.id)).resolves.toBe('cleaned');
      const version = (await setup.ctx.get(AssetRepository).getById(p.version.id))!;
      expect(version.backupChecksum).toEqual(phoneChecksum);
      expect(restoreIphoneBackupImage(sourceBytes, version.backupMetadata!)).toEqual(phoneBytes);
      expect(await readFile(p.sourcePath)).toEqual(sourceBytes);
      await expect(readFile(p.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(p.service.restore(p.version.id)).resolves.toBe('restored');
      expect(await readFile(p.stagedPath)).toEqual(phoneBytes);
    });

    /** 清理前原片或暂存文件变化时，必须保留全部文件并拒绝旧计划。 */
    it('rejects a stale plan and forged source checksum', async () => {
      const p = await pair();
      const plan = await matched(p.service);
      await expect(p.service.prepare({ ...plan, sourceChecksum: '00'.repeat(20) })).rejects.toThrow(
        'Backup source changed',
      );
      await writeFile(p.stagedPath, Buffer.from('changed-file'));
      await expect(p.service.prepare(plan)).rejects.toThrow();
      expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
      const version = await setup.ctx.get(AssetRepository).getById(p.version.id);
      expect(version?.backupChecksum).toBeNull();
    });

    /** 源离线、变化、恢复和删除都通过真实触发器传播，不保留虚假的已备份状态。 */
    it('revokes matching when the physical source is unavailable and restores only unchanged content', async () => {
      const p = await pair();
      await p.service.prepare(await matched(p.service));
      const repo = setup.ctx.get(AssetRepository);
      await repo.update({ id: p.source.id, isOffline: true });
      expect(
        await setup.sut.getUploadAssetIdByChecksum(
          factory.auth({ user: { id: userId } }),
          p.version.contentChecksum!.toString('base64'),
        ),
      ).toBeUndefined();
      await expect(repo.getForOriginal(p.version.id, false)).rejects.toThrow();
      await repo.update({ id: p.source.id, isOffline: false });
      expect(
        await setup.sut.getUploadAssetIdByChecksum(
          factory.auth({ user: { id: userId } }),
          p.version.contentChecksum!.toString('base64'),
        ),
      ).toMatchObject({ id: p.version.id });
      await repo.update({ id: p.source.id, contentChecksum: createHash('sha1').update('different').digest() });
      const changed = await repo.getById(p.version.id);
      // 已固定的旧底稿仍可恢复完整手机版本；源指纹变化不再使有效备份失效。
      expect(changed?.isOffline).toBe(false);
      const original = await repo.getForOriginal(p.version.id, false);
      expect(original.originalPath).not.toBe(p.source.originalPath);
      await repo.update({ id: p.source.id, contentChecksum: p.source.contentChecksum });
      const restored = await repo.getById(p.version.id);
      expect(restored?.isOffline).toBe(false);
      const stackedVersion = await repo.getById(p.version.id);
      assert(stackedVersion?.stackId);
      await setup.ctx.get(StackRepository).delete(stackedVersion.stackId);
      await repo.remove({ id: p.source.id });
      expect(await repo.getById(p.version.id)).toMatchObject({
        isOffline: true,
        backupSourceId: null,
        clientChecksum: null,
      });
    });

    /** 重复准备计划幂等，已有 NEF 等堆叠的 ID 和主图不被替换。 */
    it('preserves an existing stack and prepares idempotently', async () => {
      const p = await pair();
      const other = await setup.ctx.newAsset({ ownerId: userId, libraryId, originalPath: join(root, 'raw.NEF') });
      const stack = await setup.ctx.get(StackRepository).create({ ownerId: userId }, [p.source.id, other.result.id]);
      const plan = await matched(p.service);
      const first = await p.service.prepare(plan);
      expect(await p.service.prepare(plan)).toEqual(first);
      expect(
        await database.selectFrom('stack').selectAll().where('id', '=', stack.id).executeTakeFirst(),
      ).toMatchObject({ primaryAssetId: p.source.id });
      const version = await setup.ctx.get(AssetRepository).getById(p.version.id);
      expect(version?.stackId).toBe(stack.id);
    });

    /** 删除手机版本资产不会触发共用原片删除任务，物理原片记录和文件均保留。 */
    it('does not delete the physical original when a version asset is deleted', async () => {
      const p = await pair();
      await p.service.prepare(await matched(p.service));
      const removal = newMediumService(AssetService, {
        database,
        real: [AssetRepository, AssetJobRepository, StackRepository],
        mock: [JobRepository, EventRepository, LoggingRepository],
      });
      removal.ctx.getMock(EventRepository).emit.mockResolvedValue();
      removal.ctx.getMock(JobRepository).queue.mockResolvedValue();
      await removal.sut.handleAssetDeletion({ id: p.version.id, deleteOnDisk: true });
      expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
      for (const [job] of removal.ctx.getMock(JobRepository).queue.mock.calls) {
        if (job.name === JobName.FileDelete) {
          expect(job.data.files).not.toContain(p.sourcePath);
        }
      }
      expect(await setup.ctx.get(AssetRepository).getById(p.source.id)).toMatchObject({ id: p.source.id });
    });

    /** 手机确认前、不同用户会话及待重置的会话均不能清理暂存。 */
    it('requires an acknowledged session belonging to the same owner', async () => {
      const p = await pair();
      await p.service.prepare(await matched(p.service));
      const otherUser = await setup.ctx.newUser();
      const otherSync = new SyncTestContext(database);
      const otherSession = await otherSync.newSession({ userId: otherUser.user.id });
      await expect(p.service.cleanup(p.version.id, otherSession.session.id)).rejects.toThrow('not ready');
      const { session } = await acknowledge();
      await database.updateTable('session').set({ isPendingSyncReset: true }).where('id', '=', session.id).execute();
      await expect(p.service.cleanup(p.version.id, session.id)).rejects.toThrow('not ready');
      expect(await readFile(p.stagedPath)).toEqual(p.pixels);
    });

    /** 月目录后来被符号链接替换时，即使内容相同且手机已确认，也不能删除链接目标。 */
    it('refuses cleanup through a replaced parent directory', async () => {
      const p = await pair();
      const review = join(temporary, 'Photos/Review');
      const month = join(review, '2026/10');
      await mkdir(month, { recursive: true });
      const stagedPath = join(month, 'phone.JPG');
      await rename(p.stagedPath, stagedPath);
      await database.updateTable('asset').set({ originalPath: stagedPath }).where('id', '=', p.version.id).execute();
      await p.service.prepare(await matched(p.service));
      const { session } = await acknowledge();
      const outside = join(temporary, 'unrelated-originals');
      await rename(month, outside);
      await symlink(outside, month);
      await expect(p.service.cleanup(p.version.id, session.id)).rejects.toThrow('Unsafe staged backup file');
      expect(await readFile(join(outside, 'phone.JPG'))).toEqual(p.pixels);
      expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
    });

    /** 数据库级边界阻止跨用户、指向自身以及版本引用版本，不能绕过管理服务校验。 */
    it('rejects self references, cross-owner references and reference chains', async () => {
      const p = await pair();
      const repo = setup.ctx.get(AssetRepository);
      await expect(
        repo.update({ id: p.version.id, backupChecksum: p.version.contentChecksum, backupSourceId: p.version.id }),
      ).rejects.toThrow('Invalid iPhone backup reference');
      const otherUser = await setup.ctx.newUser();
      const other = await setup.ctx.newAsset({ ownerId: otherUser.user.id, libraryId, originalPath: p.sourcePath });
      await expect(
        repo.update({
          id: p.version.id,
          backupChecksum: p.version.contentChecksum,
          backupSourceId: other.result.id,
          originalPath: p.sourcePath,
        }),
      ).rejects.toThrow('Invalid iPhone backup reference');
      await p.service.prepare(await matched(p.service));
      const next = await setup.ctx.newAsset({ ownerId: userId, libraryId, originalPath: p.sourcePath });
      await expect(
        repo.update({ id: next.result.id, backupChecksum: next.result.checksum, backupSourceId: p.version.id }),
      ).rejects.toThrow('Invalid iPhone backup reference');
    });

    /** 关联后的暂存路径即使尚未清理，也不能被外部库扫描重复导入。 */
    it('protects unremoved staging files from reimport and ignores reference rows during file scans', async () => {
      const p = await pair();
      await p.service.prepare(await matched(p.service));
      expect(
        await setup.ctx.get(AssetRepository).filterNewExternalAssetPaths(libraryId, [p.stagedPath, p.sourcePath]),
      ).toEqual([]);
      expect(await setup.ctx.get(AssetJobRepository).getForSyncAssets([p.source.id, p.version.id])).toEqual([
        expect.objectContaining({ id: p.source.id }),
      ]);
    });
  });
});
