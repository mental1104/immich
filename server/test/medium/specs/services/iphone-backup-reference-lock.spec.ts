import { createPostgres } from '@immich/sql-tools';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { assert } from 'vitest';
import { AssetFileType, ChecksumAlgorithm, DatabaseLock } from 'src/enum.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import {
  IphoneBackupReferencePlan,
  IphoneBackupReferenceService,
} from 'src/services/iphone-backup-reference.service.js';
import { IphoneBackupUploadService } from 'src/services/iphone-backup-upload.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { restoreIphoneBackupImage } from 'src/utils/iphone-backup-image.js';
import { createSyntheticIphoneHeic } from 'test/fixtures/iphone-heic.fixture.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** 用真实 PostgreSQL 锁、ExifTool 和合成文件验证证据移出发布锁后仍拒绝并发改写。 */
describe('iPhone backup reference preparation lock boundary', () => {
  let db: Kysely<DB>;
  let temporary: string;
  let root: string;
  let review: string;
  let ownerId: string;
  let libraryId: string;
  let metadata: MetadataRepository;
  let context: ReturnType<typeof newMediumService<typeof LibraryService>>;

  /** 只连接 Testcontainers 创建的独立数据库，不读取真实部署参数。 */
  beforeAll(async () => {
    db = await getKyselyDB();
  });

  /** 用例结束后关闭该测试数据库连接池。 */
  afterAll(async () => {
    await db?.destroy();
  });

  /** 每例使用独立用户、图库、原片根、暂存根和权限受限快照目录。 */
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'immich-reference-lock-'));
    root = join(temporary, 'Photos/Mobile');
    review = join(temporary, 'Photos/Review');
    const snapshots = join(temporary, 'Snapshots');
    await mkdir(root, { recursive: true });
    await mkdir(review, { recursive: true });
    await mkdir(snapshots, { mode: 0o700 });
    context = newMediumService(LibraryService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await context.ctx.newUser();
    ownerId = user.id;
    const library = await context.ctx.get(LibraryRepository).create({
      ownerId,
      name: 'Synthetic lock preparation',
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

  /** 先终止 EXIF 子进程，再回收本例临时文件和环境覆盖。 */
  afterEach(async () => {
    await metadata.teardown();
    await rm(temporary, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /**
   * 建立具有不同元数据但实际编码相同的合成照片及明确匹配计划。
   * @param format 实际测试编码，HEIC 使用无隐私可解码小样本。
   * @param regularUpload 为 true 时使用可信普通上传来源，否则使用历史暂存根。
   * @returns 真实文件、资产和严格计划；不预先创建引用或删除任何原片。
   */
  async function pair(format: 'jpeg' | 'png' | 'heic' = 'jpeg', regularUpload = false) {
    const extension = format === 'jpeg' ? 'jpg' : format;
    const sourcePath = join(root, `source.${extension}`);
    const stagedPath = join(regularUpload ? root : review, `phone.${extension}`);
    const phone =
      format === 'heic'
        ? createSyntheticIphoneHeic()
        : await sharp({ create: { width: 32, height: 24, channels: 3, background: '#335577' } })
            .toFormat(format)
            .toBuffer();
    await writeFile(stagedPath, phone);
    await writeFile(sourcePath, format === 'heic' ? createSyntheticIphoneHeic('shared') : phone);
    if (format !== 'heic') await metadata.writeTags(sourcePath, { Keywords: ['shared'] });
    const sourceBytes = await readFile(sourcePath);
    const { result: source } = await context.ctx.newAsset({
      ownerId,
      libraryId,
      originalPath: sourcePath,
      originalFileName: `source.${extension}`,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${sourcePath}`).digest(),
      contentChecksum: createHash('sha1').update(sourceBytes).digest(),
    });
    const { result: version } = await context.ctx.newAsset({
      ownerId,
      libraryId,
      originalPath: stagedPath,
      originalFileName: `phone.${extension}`,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      checksum: createHash('sha1').update(`path:${stagedPath}`).digest(),
      contentChecksum: createHash('sha1').update(phone).digest(),
      fileCreatedAt: source.fileCreatedAt,
    });
    if (regularUpload) await new IphoneBackupUploadService(db).onBackupUpload({ assetId: version.id });
    const service = new IphoneBackupReferenceService(db, metadata);
    const assessment = await service.assessAsset(version.id);
    assert(assessment?.status === 'matched' && assessment.plan);
    return { source, version, sourcePath, stagedPath, phone, sourceBytes, service, plan: assessment.plan };
  }

  /**
   * 先持有实际发布锁，使 prepare 完成锁外证明后等在明确的锁边界。
   * @param plan 已匹配计划。
   * @param service 本次准备服务，默认使用真实 EXIF 访问器。
   * @returns 准备结果的已捕获 Promise 和释放锁回调，调用者必须在 finally 中释放。
   */
  async function waitAtCommitLock(
    plan: IphoneBackupReferencePlan,
    service = new IphoneBackupReferenceService(db, metadata),
  ) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(${DatabaseLock.ForkIphoneBackup})`.execute(tx);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    // 立即绑定拒绝分支，避免测试在阻塞期间制造未处理的异步拒绝。
    const result = service
      .prepare(plan)
      .then((value) => ({ value, error: undefined }))
      .catch((error: unknown) => ({ value: undefined, error }));
    try {
      await expect
        .poll(
          async () => {
            const status = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_locks
              WHERE locktype = 'advisory' AND objid = ${DatabaseLock.ForkIphoneBackup}
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND NOT granted`.execute(db);
            return status.rows[0].count;
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
      /** 只释放本例明确持有的事务锁，不取消或重试任何后台任务。 */
      finish: async () => {
        release.resolve();
        await blocker;
      },
    };
  }

  /** ExifTool 的任意长等待都在发布锁外，另一连接仍能真实取得同一发布锁。 */
  it('allows upload publication while strict EXIF evidence is waiting', async () => {
    const p = await pair();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delayed = {
      /** @param filename 已通过归属和路径预检的文件。@returns 延迟后的完整真实元数据，保留全部原有检查。 */
      readBackupTags: async (filename: string) => {
        const tags = await metadata.readBackupTags(filename);
        if (filename === p.stagedPath) {
          entered.resolve();
          await release.promise;
        }
        return tags;
      },
    };
    const preparation = new IphoneBackupReferenceService(db, delayed).prepare(p.plan);
    await entered.promise;
    try {
      const available = await db.transaction().execute(async (tx) => {
        const result = await sql<{ acquired: boolean }>`SELECT
          pg_try_advisory_xact_lock(${DatabaseLock.ForkIphoneBackup}) AS acquired`.execute(tx);
        return result.rows[0].acquired;
      });
      expect(available).toBe(true);
      expect(
        await db.selectFrom('asset').select('backupChecksum').where('id', '=', p.version.id).executeTakeFirstOrThrow(),
      ).toEqual({ backupChecksum: null });
    } finally {
      release.resolve();
      await preparation;
    }
  });

  /** 文件证明结束后到取得锁之前的变化，仍必须拒绝；签名也能识别同字节换 inode。 */
  it.each(['source-rewrite', 'version-replace', 'version-grow', 'version-symlink'] as const)(
    'rejects a file race after full EXIF evidence: %s',
    async (change) => {
      const p = await pair();
      const waiting = await waitAtCommitLock(p.plan);
      try {
        switch (change) {
          case 'source-rewrite': {
            await metadata.writeTags(p.sourcePath, { Keywords: ['new metadata after proof'] });
            break;
          }
          case 'version-replace': {
            await rename(p.stagedPath, `${p.stagedPath}.previous`);
            await writeFile(p.stagedPath, p.phone);
            break;
          }
          case 'version-grow': {
            await appendFile(p.stagedPath, Buffer.from('changed after proof'));
            break;
          }
          case 'version-symlink': {
            await rename(p.stagedPath, `${p.stagedPath}.previous`);
            await symlink(`${p.stagedPath}.previous`, p.stagedPath);
            break;
          }
        }
      } finally {
        await waiting.finish();
      }
      const outcome = await waiting.result;
      expect(outcome.error).toBeInstanceOf(Error);
      expect(
        await db.selectFrom('asset').select('backupChecksum').where('id', '=', p.version.id).executeTakeFirstOrThrow(),
      ).toEqual({ backupChecksum: null });
      expect(await readFile(p.stagedPath)).toBeInstanceOf(Buffer);
    },
  );

  /** 锁外未出现的关联数据或源状态变化不能绕过锁内数据库复查。 */
  it.each(['sidecar', 'source-offline'] as const)('rejects a database race after EXIF evidence: %s', async (change) => {
    const p = await pair();
    const waiting = await waitAtCommitLock(p.plan);
    try {
      if (change === 'sidecar') {
        await db
          .insertInto('asset_file')
          .values({ assetId: p.version.id, type: AssetFileType.Sidecar, path: join(review, 'phone.xmp') })
          .execute();
      } else {
        await db.updateTable('asset').set({ isOffline: true }).where('id', '=', p.source.id).execute();
      }
    } finally {
      await waiting.finish();
    }
    const outcome = await waiting.result;
    expect(outcome.error).toBeInstanceOf(Error);
    expect(await readFile(p.stagedPath)).toEqual(p.phone);
    expect(
      await db.selectFrom('asset').select('backupChecksum').where('id', '=', p.version.id).executeTakeFirstOrThrow(),
    ).toEqual({ backupChecksum: null });
  });

  /** 三种已支持编码在锁边界变更后仍保留手机版本完整哈希和逐字节恢复。 */
  it.each(['jpeg', 'png', 'heic'] as const)('preserves exact %s recovery and identity', async (format) => {
    const p = await pair(format);
    await p.service.prepare(p.plan);
    const version = await db.selectFrom('asset').selectAll().where('id', '=', p.version.id).executeTakeFirstOrThrow();
    assert(version.backupMetadata);
    expect(version.backupChecksum).toEqual(createHash('sha1').update(p.phone).digest());
    expect(version.clientChecksum).toEqual(p.version.clientChecksum);
    expect(restoreIphoneBackupImage(p.sourceBytes, version.backupMetadata)).toEqual(p.phone);
    expect(await readFile(p.sourcePath)).toEqual(p.sourceBytes);
    expect(await readFile(p.stagedPath)).toEqual(p.phone);
  });

  /** 暂存已清理的关联重入不能再次等待 EXIF 或尝试读取已不存在的手机版本路径。 */
  it('prepares idempotently with absent staging and an unavailable EXIF reader', async () => {
    const p = await pair();
    const first = await p.service.prepare(p.plan);
    await unlink(p.stagedPath);
    const reader = vi.spyOn(metadata, 'readBackupTags').mockRejectedValue(new Error('Synthetic EXIF unavailable'));
    await expect(p.service.prepare(p.plan)).resolves.toEqual(first);
    expect(reader).not.toHaveBeenCalled();
  });

  /** 两个同时完成锁外证明的准备只创建一次引用，后者返回相同最终游标。 */
  it('serializes concurrent preparations without changing an existing reference', async () => {
    const p = await pair();
    const [first, second] = await Promise.all([p.service.prepare(p.plan), p.service.prepare(p.plan)]);
    expect(second).toEqual(first);
    expect(await db.selectFrom('stack').select('id').where('ownerId', '=', ownerId).execute()).toHaveLength(1);
    expect(await readFile(p.stagedPath)).toEqual(p.phone);
  });

  /** 可信普通上传路径在事务内必须复用同一连接，单连接池不能因借第二连接而永久等待。 */
  it('prepares a trusted regular upload with a one-connection pool', async () => {
    const p = await pair('jpeg', true);
    const current = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = `/${current.rows[0].name}`;
    const single = new Kysely<DB>({
      dialect: new PostgresJSDialect({
        postgres: createPostgres({ maxConnections: 1, connection: { connectionType: 'url', url: url.href } }),
      }),
    });
    try {
      await new IphoneBackupReferenceService(single, metadata).prepare(p.plan);
      expect(
        await single
          .selectFrom('asset')
          .select('backupSourceId')
          .where('id', '=', p.version.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ backupSourceId: p.source.id });
    } finally {
      await single.destroy();
    }
  });

  /** 证据前移不能把 ExifTool 警告变成可忽略错误，也不能降低既有元数据计划校验。 */
  it.each(['warning', 'metadata-plan'] as const)('retains strict evidence rejection: %s', async (change) => {
    const p = await pair();
    if (change === 'warning') {
      const original = metadata.readBackupTags.bind(metadata);
      vi.spyOn(metadata, 'readBackupTags').mockImplementation(async (filename) => ({
        ...(await original(filename)),
        warnings: ['Synthetic metadata warning'],
      }));
    } else {
      p.plan.metadata = '0'.repeat(64);
    }
    await expect(p.service.prepare(p.plan)).rejects.toThrow();
    expect(await readFile(p.stagedPath)).toEqual(p.phone);
  });

  /** 仅匹配压缩图像摘要还不够；JPEG Adobe 配置属于必须保留的独立渲染证明。 */
  it('rejects changed JPEG Adobe rendering configuration with identical image data', async () => {
    const p = await pair();
    const original = await metadata.readBackupTags(p.sourcePath);
    const payload = Buffer.from([0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 1]);
    const marker = Buffer.alloc(4);
    marker.writeUInt16BE(0xff_ee);
    marker.writeUInt16BE(payload.length + 2, 2);
    const changed = Buffer.concat([p.sourceBytes.subarray(0, 2), marker, payload, p.sourceBytes.subarray(2)]);
    await writeFile(p.sourcePath, changed);
    const current = await metadata.readBackupTags(p.sourcePath);
    expect(current['File:ImageDataHash']).toBe(original['File:ImageDataHash']);
    p.plan.sourceChecksum = createHash('sha1').update(changed).digest('hex');
    await db
      .updateTable('asset')
      .set({ contentChecksum: Buffer.from(p.plan.sourceChecksum, 'hex') })
      .where('id', '=', p.source.id)
      .execute();
    await expect(p.service.prepare(p.plan)).rejects.toThrow('not metadata-only equivalents');
    expect(await readFile(p.stagedPath)).toEqual(p.phone);
  });

  /** HEIC 解码配置也不能因为图像载荷相同而在前置证据阶段漏掉。 */
  it('rejects changed HEIC decoder configuration with identical image data', async () => {
    const p = await pair('heic');
    const original = await metadata.readBackupTags(p.sourcePath);
    const changed = Buffer.from(p.sourceBytes);
    const decoder = changed.indexOf(Buffer.from('hvcC'));
    assert(decoder > 0);
    changed[decoder + 5] ^= 1;
    await writeFile(p.sourcePath, changed);
    const current = await metadata.readBackupTags(p.sourcePath);
    expect(current['File:ImageDataHash']).toBe(original['File:ImageDataHash']);
    p.plan.sourceChecksum = createHash('sha1').update(changed).digest('hex');
    await db
      .updateTable('asset')
      .set({ contentChecksum: Buffer.from(p.plan.sourceChecksum, 'hex') })
      .where('id', '=', p.source.id)
      .execute();
    await expect(p.service.prepare(p.plan)).rejects.toThrow('not metadata-only equivalents');
    expect(await readFile(p.stagedPath)).toEqual(p.phone);
  });
});
