import { Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { assert } from 'vitest';
import { ChecksumAlgorithm, DatabaseLock } from 'src/enum.js';
import { IphoneBackupImageRepository } from 'src/repositories/iphone-backup-image.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { IphoneBackupSourceService } from 'src/services/iphone-backup-source.service.js';
import { IphoneBackupUploadService } from 'src/services/iphone-backup-upload.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { readIphoneBackupSnapshot } from 'src/utils/iphone-backup-snapshot.js';
import { createSyntheticIphoneHeic } from 'test/fixtures/iphone-heic.fixture.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** 用真实锁与实际 EXIF 读取证明源巡检不会持发布锁等待进程池，且前置证据不能绕过并发校验。 */
describe('iPhone backup source refresh lock boundary', () => {
  let db: Kysely<DB>;
  let temporary: string;
  let root: string;
  let review: string;
  let snapshots: string;
  let ownerId: string;
  let libraryId: string;
  let metadata: MetadataRepository;
  let context: ReturnType<typeof newMediumService<typeof LibraryService>>;

  /** 只使用 Testcontainers 新建的独立数据库及模板，不读取真实服务器连接。 */
  beforeAll(async () => {
    db = await getKyselyDB();
  });

  /** 释放本测试文件的独立连接池。 */
  afterAll(async () => {
    await db?.destroy();
  });

  /** 每例新建用户、导入库、暂存目录、私有快照目录和 EXIF 进程。 */
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'immich-source-lock-'));
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
      name: 'Synthetic source lock',
      importPaths: [join(temporary, 'Photos')],
      exclusionPatterns: [],
    });
    libraryId = library.id;
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', libraryId);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', root);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_HISTORICAL_ROOT', review);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT', snapshots);
    metadata = new MetadataRepository(LoggingRepository.create());
  });

  /** 等待 EXIF 进程关闭后，仅清理本例合成文件与环境覆盖。 */
  afterEach(async () => {
    await metadata.teardown();
    await rm(temporary, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /**
   * 建立已保存可信上传底稿、随后被 NAS 仅改元数据的普通原片。
   * @param format 实际编码，HEIC 使用可解码的无隐私合成图。
   * @returns 初始手机版本、NAS 现版本及其真实资产，未预先执行源复核。
   */
  async function captured(format: 'jpeg' | 'png' | 'heic' = 'jpeg') {
    const suffix = format === 'jpeg' ? 'jpg' : format;
    const sourcePath = join(root, `source.${suffix}`);
    const phone =
      format === 'heic'
        ? createSyntheticIphoneHeic()
        : await sharp({ create: { width: 32, height: 24, channels: 3, background: '#557799' } })
            .toFormat(format)
            .toBuffer();
    await writeFile(sourcePath, phone);
    const checksum = createHash('sha1').update(phone).digest();
    const { result: source } = await context.ctx.newAsset({
      ownerId,
      libraryId,
      originalPath: sourcePath,
      originalFileName: `source.${suffix}`,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${sourcePath}`).digest(),
      contentChecksum: checksum,
    });
    await new IphoneBackupUploadService(db).onBackupUpload({ assetId: source.id });
    if (format === 'heic') {
      await writeFile(sourcePath, createSyntheticIphoneHeic('shared and corrected metadata'));
    } else {
      await metadata.writeTags(sourcePath, { Keywords: ['shared', 'corrected metadata'] });
    }
    const nas = await readFile(sourcePath);
    const service = new IphoneBackupSourceService(db, metadata);
    return { source, sourcePath, phone, checksum, nas, service };
  }

  /**
   * 持有实际发布锁，使复核在完整锁外证据已完成后等待提交边界。
   * @param sourceId 当前合成可信来源 ID。
   * @returns 已捕获的复核结果及必须在 finally 中调用的锁释放回调。
   */
  async function waitAtCommitLock(sourceId: string) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(${DatabaseLock.ForkIphoneBackup})`.execute(tx);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const result = new IphoneBackupSourceService(db, metadata)
      .refreshSource(sourceId)
      .then((value) => ({ value, error: undefined }))
      .catch((error: unknown) => ({ value: undefined, error }));
    try {
      await expect
        .poll(
          async () => {
            const locks = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_locks
              WHERE locktype = 'advisory' AND objid = ${DatabaseLock.ForkIphoneBackup}
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND NOT granted`.execute(db);
            return locks.rows[0].count;
          },
          { timeout: 10_000 },
        )
        .toBe(1);
    } catch (error) {
      release.resolve();
      await blocker;
      await result;
      throw error;
    }
    return {
      result,
      /** 只结束本例显式持有的事务，不取消任何应用后台任务。 */
      finish: async () => {
        release.resolve();
        await blocker;
      },
    };
  }

  /** ExifTool 尚未返回完整证据时，另一连接仍可取得上传的发布锁。 */
  it('allows upload publication while source EXIF evidence is waiting', async () => {
    const p = await captured();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delayed = {
      /** @param path 已通过源归属预检的实际文件。@returns 延迟后的完整真实 EXIF 证据，不降低校验。 */
      readBackupTags: async (path: string) => {
        const tags = await metadata.readBackupTags(path);
        entered.resolve();
        await release.promise;
        return tags;
      },
    };
    const refresh = new IphoneBackupSourceService(db, delayed).refreshSource(p.source.id);
    await entered.promise;
    try {
      const available = await db.transaction().execute(async (tx) => {
        const locks = await sql<{ acquired: boolean }>`SELECT
          pg_try_advisory_xact_lock(${DatabaseLock.ForkIphoneBackup}) AS acquired`.execute(tx);
        return locks.rows[0].acquired;
      });
      expect(available).toBe(true);
      const origin = await new IphoneBackupImageRepository(db).getUpload(p.source.id);
      expect(origin?.recoveredAssetId).toBeNull();
    } finally {
      release.resolve();
      await refresh;
    }
  });

  /** 锁外证明之后的文件改写不能被新快照、旧身份恢复或数据库摘要更新误当成同一证据。 */
  it.each(['rewrite', 'replace', 'grow', 'symlink'] as const)(
    'rejects a source file race after EXIF: %s',
    async (change) => {
      const p = await captured();
      const waiting = await waitAtCommitLock(p.source.id);
      try {
        switch (change) {
          case 'rewrite': {
            await metadata.writeTags(p.sourcePath, { Keywords: ['another edit after proof'] });
            break;
          }
          case 'replace': {
            await rename(p.sourcePath, `${p.sourcePath}.previous`);
            await writeFile(p.sourcePath, p.nas);
            break;
          }
          case 'grow': {
            await appendFile(p.sourcePath, Buffer.from('changed after proof'));
            break;
          }
          case 'symlink': {
            await rename(p.sourcePath, `${p.sourcePath}.previous`);
            await symlink(`${p.sourcePath}.previous`, p.sourcePath);
            break;
          }
        }
      } finally {
        await waiting.finish();
      }
      const outcome = await waiting.result;
      expect(outcome.error).toBeInstanceOf(Error);
      const source = await db.selectFrom('asset').selectAll().where('id', '=', p.source.id).executeTakeFirstOrThrow();
      expect(source.contentChecksum).toEqual(p.checksum);
      const repository = new IphoneBackupImageRepository(db);
      expect(await repository.listSnapshots(p.source.id)).toHaveLength(1);
      const origin = await repository.getUpload(p.source.id);
      expect(origin?.recoveredAssetId).toBeNull();
      expect(await db.selectFrom('asset').select('id').where('libraryId', '=', libraryId).execute()).toHaveLength(1);
    },
  );

  /** 取得证据后变化的源可用性、路径和图库配置，必须由锁内新状态拒绝。 */
  it.each(['offline', 'path', 'deleted-library'] as const)('rejects a database race after EXIF: %s', async (change) => {
    const p = await captured();
    const waiting = await waitAtCommitLock(p.source.id);
    try {
      switch (change) {
        case 'offline': {
          await db.updateTable('asset').set({ isOffline: true }).where('id', '=', p.source.id).execute();
          break;
        }
        case 'path': {
          const nextPath = join(root, 'changed-path.jpg');
          await writeFile(nextPath, p.nas);
          await db.updateTable('asset').set({ originalPath: nextPath }).where('id', '=', p.source.id).execute();
          break;
        }
        case 'deleted-library': {
          await db.updateTable('library').set({ deletedAt: new Date() }).where('id', '=', libraryId).execute();
          break;
        }
      }
    } finally {
      await waiting.finish();
    }
    const outcome = await waiting.result;
    expect(outcome.error).toBeInstanceOf(Error);
    const source = await db.selectFrom('asset').selectAll().where('id', '=', p.source.id).executeTakeFirstOrThrow();
    expect(source.contentChecksum).toEqual(p.checksum);
    const origin = await new IphoneBackupImageRepository(db).getUpload(p.source.id);
    expect(origin?.recoveredAssetId).toBeNull();
    expect(await readFile(p.sourcePath)).toEqual(p.nas);
  });

  /** 实际元数据变化后，三类支持编码都固定原手机 SHA/底稿并发布当前 NAS 摘要。 */
  it.each(['jpeg', 'png', 'heic'] as const)(
    'preserves original %s uploads across a metadata refresh',
    async (format) => {
      const p = await captured(format);
      const refreshed = await p.service.refreshSource(p.source.id);
      expect(refreshed.status).toBe('refreshed');
      assert(refreshed.recoveredAssetId);
      const recovered = await db
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', refreshed.recoveredAssetId)
        .executeTakeFirstOrThrow();
      expect(recovered.contentChecksum).toEqual(p.checksum);
      expect(await readFile(recovered.originalPath)).toEqual(p.phone);
      const source = await db.selectFrom('asset').selectAll().where('id', '=', p.source.id).executeTakeFirstOrThrow();
      expect(source.contentChecksum).toEqual(createHash('sha1').update(p.nas).digest());
      expect(await readFile(p.sourcePath)).toEqual(p.nas);
      const snapshot = await new IphoneBackupImageRepository(db).getSnapshot(p.source.id, p.checksum);
      assert(snapshot);
      expect(
        await readIphoneBackupSnapshot({ path: snapshot.path, root: snapshots, checksum: p.checksum.toString('hex') }),
      ).toEqual(p.phone);
    },
  );

  /** 原有严格警告拒绝仍在锁外生效，不发布新源摘要、初始恢复或新底稿记录。 */
  it('keeps strict metadata warnings as failures before publishing a refreshed source', async () => {
    const p = await captured();
    const original = metadata.readBackupTags.bind(metadata);
    vi.spyOn(metadata, 'readBackupTags').mockImplementation(async (path) => ({
      ...(await original(path)),
      warnings: ['Synthetic metadata warning'],
    }));
    await expect(p.service.refreshSource(p.source.id)).rejects.toThrow('metadata has warnings');
    const repository = new IphoneBackupImageRepository(db);
    expect(await repository.listSnapshots(p.source.id)).toHaveLength(1);
    const origin = await repository.getUpload(p.source.id);
    expect(origin?.recoveredAssetId).toBeNull();
    expect(await readFile(p.sourcePath)).toEqual(p.nas);
  });
});
