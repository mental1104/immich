import { Kysely } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { crc32, gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import type { UploadFile } from 'src/types.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { ChecksumAlgorithm, JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
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
import { IphoneBackupUploadService } from 'src/services/iphone-backup-upload.service.js';
import { createIphoneBackupRecovery, restoreIphoneBackupImage } from 'src/utils/iphone-backup-image.js';
import { readIphoneBackupSnapshot } from 'src/utils/iphone-backup-snapshot.js';
import { createSyntheticIphoneHeic } from 'test/fixtures/iphone-heic.fixture.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** 真实上传发布、内部同步事件、私有快照及来源表的隔离集成验证。 */
describe('trusted iPhone backup upload capture', () => {
  let db: Kysely<DB>;
  let temporary: string;
  let root: string;
  let review: string;
  let snapshots: string;
  let ownerId: string;
  let libraryId: string;
  let capture: IphoneBackupUploadService;
  let setup: ReturnType<typeof newMediumService<typeof AssetMediaService>>;

  /** 只连接 Testcontainers 提供的独立测试数据库。 */
  beforeAll(async () => {
    db = await getKyselyDB();
  });

  /** 释放本文件创建的连接池。 */
  afterAll(async () => {
    await db?.destroy();
  });

  /** 每例使用独立合成文件、用户和图库，不读取任何实际照片。 */
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'immich-upload-origin-'));
    root = join(temporary, 'Photos/Mobile');
    review = join(temporary, 'Photos/Review');
    snapshots = join(temporary, 'Snapshots');
    await mkdir(root, { recursive: true });
    await mkdir(review, { recursive: true });
    await mkdir(snapshots, { mode: 0o700 });
    setup = newMediumService(AssetMediaService, {
      database: db,
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
    const { user } = await setup.ctx.newUser();
    ownerId = user.id;
    const library = await setup.ctx.get(LibraryRepository).create({
      ownerId,
      name: 'Upload origin synthetic library',
      importPaths: [join(temporary, 'Photos')],
      exclusionPatterns: [],
    });
    libraryId = library.id;
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', libraryId);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', root);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', review);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_MIN_MONTH', '202611');
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT', snapshots);
    capture = new IphoneBackupUploadService(db);
    vi.spyOn(setup.ctx.get(MetadataRepository), 'readTags').mockResolvedValue({});
    // 使用实际事件处理器；异步队列仍为 mock，便于证明来源先于元数据任务完成持久化。
    setup.ctx.getMock(EventRepository).emit.mockImplementation(async (event, ...args) => {
      if (event === 'ForkIphoneBackupUpload') await capture.onBackupUpload(args[0] as { assetId: string });
    });
    setup.ctx.getMock(JobRepository).queue.mockImplementation(async (job) => {
      if (job.name !== JobName.AssetExtractMetadata) {
        return;
      }

      const origin = await db
        .selectFrom('fork_iphone_upload_origin')
        .select('assetId')
        .where('assetId', '=', job.data.id)
        .executeTakeFirst();
      expect(origin?.assetId).toBe(job.data.id);
    });
  });

  /** 关闭 EXIF 进程后清除全部独立合成文件。 */
  afterEach(async () => {
    await setup.ctx.get(MetadataRepository).teardown();
    await rm(temporary, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** @param bytes 合成文件实际字节。@param name 模拟客户端原始文件名。@returns 由服务端完整 SHA-1 标识的暂存文件。 */
  async function makeUpload(bytes: Buffer, name = 'phone.jpg'): Promise<UploadFile> {
    const originalPath = join(temporary, `${randomUUID()}${extname(name)}`);
    await writeFile(originalPath, bytes);
    return {
      uuid: randomUUID(),
      originalPath,
      originalName: name,
      size: bytes.length,
      checksum: createHash('sha1').update(bytes).digest(),
    };
  }

  /** @param file 完整合成上传。@param historical 是否走已配置的历史暂存目录。@returns 未修改的官方上传响应。 */
  function upload(file: UploadFile, historical = false) {
    return setup.sut.uploadAsset(
      factory.auth({ user: { id: ownerId } }),
      {
        fileCreatedAt: new Date(historical ? '2026-10-05T03:00:00Z' : '2026-11-05T03:00:00Z'),
        fileModifiedAt: new Date('2026-11-05T03:00:00Z'),
        assetData: Buffer.from('unused'),
      },
      file,
    );
  }

  /** 文件头决定支持格式；两种格式都在元数据队列前固定完整手机版本。 */
  it.each(['jpeg', 'png'] as const)('captures %s original bytes before metadata extraction starts', async (format) => {
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#446688' } })
      .toFormat(format)
      .toBuffer();
    const file = await makeUpload(bytes, format === 'jpeg' ? 'phone.jpg' : 'phone.png');
    const result = await upload(file, format === 'png');
    expect(result.status).toBe(AssetMediaStatus.CREATED);
    const asset = await db.selectFrom('asset').selectAll().where('id', '=', result.id).executeTakeFirstOrThrow();
    const origin = await db
      .selectFrom('fork_iphone_upload_origin')
      .selectAll()
      .where('assetId', '=', result.id)
      .executeTakeFirstOrThrow();
    const snapshot = await db
      .selectFrom('fork_iphone_source_snapshot')
      .selectAll()
      .where('sourceId', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(origin.checksum).toEqual(file.checksum);
    expect(origin.snapshot.originalFileName).toBe(file.originalName);
    expect(origin.originalPath.startsWith(format === 'png' ? review : root)).toBe(true);
    expect(asset.checksumAlgorithm).toBe(ChecksumAlgorithm.sha1Path);
    expect(asset.contentChecksum).toEqual(file.checksum);
    const preserved = await readIphoneBackupSnapshot({
      path: snapshot.path,
      root: snapshots,
      checksum: file.checksum.toString('hex'),
    });
    expect(preserved).toEqual(bytes);
    expect(restoreIphoneBackupImage(preserved, origin.recovery!)).toEqual(bytes);
    expect(await readFile(asset.originalPath)).toEqual(bytes);
  });

  /** 已宣告给手机的 A 原片下载始终使用已固定快照，NAS 改为 B2 后不等待巡检也不能返回错误字节。 */
  it('serves the original captured HEIC bytes before a NAS metadata edit has been reconciled', async () => {
    const bytes = createSyntheticIphoneHeic();
    const file = await makeUpload(bytes, 'phone.HEIC');
    const result = await upload(file);
    expect(result.status).toBe(AssetMediaStatus.CREATED);
    const asset = await db.selectFrom('asset').selectAll().where('id', '=', result.id).executeTakeFirstOrThrow();
    const origin = await db
      .selectFrom('fork_iphone_upload_origin')
      .selectAll()
      .where('assetId', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(gunzipSync(origin.recovery!).toString('utf8'))).toMatchObject({ version: 2, format: 'HEIC' });
    const changed = createSyntheticIphoneHeic('NAS changed tags before the next polling cycle');
    await writeFile(asset.originalPath, changed);
    const download = await setup.ctx.get(AssetRepository).getForOriginal(asset.id, false);
    expect(download.backupMetadata).toBeNull();
    expect(download.originalPath).not.toBe(asset.originalPath);
    expect(download.originalPath?.endsWith('.heic')).toBe(true);
    const delivered = await readFile(download.originalPath!);
    expect(delivered).toEqual(bytes);
    expect(createHash('sha1').update(delivered).digest()).toEqual(file.checksum);
    expect(await readFile(asset.originalPath)).toEqual(changed);
    const stored = await db
      .selectFrom('asset')
      .select('contentChecksum')
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(stored.contentChecksum).toEqual(file.checksum);
  });

  /** 具有真实 HEVC 图像但包含未知合法扩展盒的 HEIF 保留完整上传，不因优化不支持而回滚 API 成功。 */
  it('keeps a HEIC with an unknown container extension as a full upload without claiming a snapshot', async () => {
    const extension = Buffer.alloc(24);
    extension.writeUInt32BE(extension.length, 0);
    extension.write('uuid', 4, 'ascii');
    const bytes = Buffer.concat([createSyntheticIphoneHeic(), extension]);
    const result = await upload(await makeUpload(bytes, 'extended.HEIC'));
    expect(result.status).toBe(AssetMediaStatus.CREATED);
    const origin = await db
      .selectFrom('fork_iphone_upload_origin')
      .selectAll()
      .where('assetId', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(origin.recovery).toBeNull();
    expect(origin.checksum).toEqual(createHash('sha1').update(bytes).digest());
    expect(await readFile(origin.originalPath)).toEqual(bytes);
    expect(
      await db.selectFrom('fork_iphone_source_snapshot').selectAll().where('sourceId', '=', result.id).execute(),
    ).toEqual([]);
    const download = await setup.ctx.get(AssetRepository).getForOriginal(result.id, false);
    expect(download.originalPath).toBe(origin.originalPath);
    expect(await readFile(download.originalPath!)).toEqual(bytes);
  });

  /** 同一个内部事件重复投递也不能覆盖最初手机版本的时间、完整哈希和恢复资料。 */
  it('never overwrites captured origins after NAS metadata rewrites', async () => {
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#446688' } })
      .jpeg()
      .toBuffer();
    const result = await upload(await makeUpload(bytes));
    const original = await db
      .selectFrom('fork_iphone_upload_origin')
      .selectAll()
      .where('assetId', '=', result.id)
      .executeTakeFirstOrThrow();
    const asset = await db.selectFrom('asset').selectAll().where('id', '=', result.id).executeTakeFirstOrThrow();
    await setup.ctx
      .get(MetadataRepository)
      .writeTags(asset.originalPath, { Keywords: ['shared'], DateTimeOriginal: '2024:01:02 03:04:05' });
    await db
      .updateTable('asset')
      .set({
        contentChecksum: createHash('sha1')
          .update(await readFile(asset.originalPath))
          .digest(),
      })
      .where('id', '=', asset.id)
      .execute();
    await capture.onBackupUpload({ assetId: result.id });
    const repeated = await db
      .selectFrom('fork_iphone_upload_origin')
      .selectAll()
      .where('assetId', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(repeated).toEqual(original);
  });

  /** 普通原归档目录的资产没有上传发布来源，名称、日期或公开元数据不能获得可信来源。 */
  it('does not capture unrelated NAS originals outside the configured upload destinations', async () => {
    const originalPath = join(temporary, 'Photos/NAS-original.jpg');
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#446688' } })
      .jpeg()
      .toBuffer();
    await writeFile(originalPath, bytes);
    const { result: asset } = await setup.ctx.newAsset({
      ownerId,
      libraryId,
      originalPath,
      isExternal: true,
      contentChecksum: createHash('sha1').update(bytes).digest(),
    });
    await capture.onBackupUpload({ assetId: asset.id });
    expect(
      await db.selectFrom('fork_iphone_upload_origin').selectAll().where('assetId', '=', asset.id).execute(),
    ).toEqual([]);
    expect(await readdir(snapshots)).toEqual([]);
    expect(await readFile(originalPath)).toEqual(bytes);
  });

  /** 未支持的格式保留完整原片，可信来源不附带未经证明的恢复配方。 */
  it('records unsupported uploads without a recovery recipe or private image snapshot', async () => {
    const bytes = Buffer.from('synthetic unsupported HEIC payload');
    const result = await upload(await makeUpload(bytes, 'phone.HEIC'));
    const origin = await db
      .selectFrom('fork_iphone_upload_origin')
      .selectAll()
      .where('assetId', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(origin.recovery).toBeNull();
    expect(origin.checksum).toEqual(createHash('sha1').update(bytes).digest());
    expect(await readFile(origin.originalPath)).toEqual(bytes);
    expect(await readdir(snapshots)).toEqual([]);
  });

  /** 有效 PNG 的低压缩率文本元数据超过配方上限时，仍保留完整上传和经过完整校验的私有底稿。 */
  it('retains a valid PNG with oversized recovery metadata as a full backup', async () => {
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
    // 真正解码确认块顺序、长度及 CRC 均有效；并确认触发的是实际配方上限而不是模拟异常。
    expect(await sharp(bytes).raw().toBuffer()).toEqual(await sharp(base).raw().toBuffer());
    expect(() => createIphoneBackupRecovery(bytes, bytes)).toThrow('Backup metadata recovery exceeds size limit');
    const file = await makeUpload(bytes, 'large-metadata.png');
    const result = await upload(file);
    expect(result.status).toBe(AssetMediaStatus.CREATED);
    const origin = await db
      .selectFrom('fork_iphone_upload_origin')
      .selectAll()
      .where('assetId', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(origin.recovery).toBeNull();
    expect(origin.checksum).toEqual(file.checksum);
    expect(await readFile(origin.originalPath)).toEqual(bytes);
    const snapshot = await db
      .selectFrom('fork_iphone_source_snapshot')
      .selectAll()
      .where('sourceId', '=', result.id)
      .where('checksum', '=', file.checksum)
      .executeTakeFirstOrThrow();
    expect(
      await readIphoneBackupSnapshot({ path: snapshot.path, root: snapshots, checksum: file.checksum.toString('hex') }),
    ).toEqual(bytes);
  }, 30_000);

  /** 超限文件采用流式完整摘要并保留完整备份，不因具有 JPEG 文件头就尝试无损共用。 */
  it('retains an oversized JPEG upload as a complete file with no recovery recipe', async () => {
    const file = await makeUpload(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const size = 64 * 1024 * 1024 + 1;
    await truncate(file.originalPath, size);
    const hash = createHash('sha1');
    for await (const chunk of createReadStream(file.originalPath)) hash.update(chunk);
    const result = await upload({ ...file, checksum: hash.digest(), size });
    const origin = await db
      .selectFrom('fork_iphone_upload_origin')
      .selectAll()
      .where('assetId', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(origin.recovery).toBeNull();
    expect(await readdir(snapshots)).toEqual([]);
  });

  /** 复制后实际字节不等于服务端接收哈希时不发布成功，也不启动元数据处理。 */
  it('rolls back published files and assets when the actual upload checksum disagrees', async () => {
    const file = await makeUpload(Buffer.from('synthetic unsupported payload'), 'phone.HEIC');
    const bad = { ...file, checksum: createHash('sha1').update('different bytes').digest() };
    await expect(upload(bad)).rejects.toThrow('checksum mismatch');
    expect(await db.selectFrom('asset').select('id').where('libraryId', '=', libraryId).execute()).toEqual([]);
    expect(setup.ctx.getMock(JobRepository).queue).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: JobName.AssetExtractMetadata,
      }),
    );
    expect(await readFile(file.originalPath)).toEqual(Buffer.from('synthetic unsupported payload'));
  });

  /** 支持格式在私有目录未配置时明确失败，不先返回成功再丢失最初版本的恢复证据。 */
  it('rolls back a supported upload when its private snapshot destination is unavailable', async () => {
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#446688' } })
      .jpeg()
      .toBuffer();
    const file = await makeUpload(bytes);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT', '');
    await expect(upload(file)).rejects.toThrow('snapshot root');
    expect(await db.selectFrom('asset').select('id').where('libraryId', '=', libraryId).execute()).toEqual([]);
    expect(setup.ctx.getMock(JobRepository).queue).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: JobName.AssetExtractMetadata,
      }),
    );
    expect(await readFile(file.originalPath)).toEqual(bytes);
    expect(await readdir(snapshots)).toEqual([]);
  });
});
