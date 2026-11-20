import { Kysely, sql, type Insertable } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetType, ChecksumAlgorithm, DatabaseLock } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import type { DB } from 'src/schema/index.js';
import type { AssetTable } from 'src/schema/tables/asset.table.js';
import { getKyselyConfig } from 'src/utils/database.js';

/** 使用明确指定的独立库验证真实事务，不连接生产图库，也不运行生产迁移。 */
describe('external publication transactions', () => {
  let database: Kysely<DB>;
  let blocker: Kysely<DB>;
  let repository: AssetRepository;
  let template: Kysely<DB> | undefined;
  let cloneName: string | undefined;
  const ownerId = randomUUID();
  const libraryId = randomUUID();

  beforeAll(async () => {
    const dedicated = process.env.IMMICH_EXTERNAL_PUBLICATION_TEST_URL;
    const url = new URL(dedicated ?? process.env.IMMICH_TEST_POSTGRES_URL!);
    if (dedicated) {
      if (url.pathname !== '/immich_library_recovery_test') throw new Error('Refusing non-test database');
    } else {
      if (url.pathname !== '/mich') throw new Error('Refusing non-test template');
      // 常规 medium 测试沿用现有模板容器，但为本文件创建独立数据库，不污染模板或其他测试。
      template = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.toString() }));
      cloneName = 'external_publication_' + randomUUID().replaceAll('-', '');
      await sql`create database ${sql.id(cloneName)} template ${sql.id('mich')}`.execute(template);
      url.pathname = '/' + cloneName;
    }
    database = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.toString() }));
    blocker = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.toString() }));
    repository = new AssetRepository(database);
    await database.insertInto('cluster_group').values({ id: ownerId, name: 'Synthetic test' }).execute();
    await sql`insert into "user" (id,email,name,"clusterGroupId") values (${ownerId},${ownerId + '@example.invalid'},'Synthetic test',${ownerId})`.execute(
      database,
    );
    await database
      .insertInto('library')
      .values({ id: libraryId, ownerId, name: 'Synthetic test', importPaths: ['/synthetic'], exclusionPatterns: [] })
      .execute();
  });
  afterAll(async () => {
    if (database) {
      await database.deleteFrom('user').where('id', '=', ownerId).execute();
      await database.deleteFrom('cluster_group').where('id', '=', ownerId).execute();
      await database.destroy();
    }
    await blocker?.destroy();
    if (template && cloneName) {
      await sql`drop database ${sql.id(cloneName)}`.execute(template);
      await template.destroy();
    }
  });

  /** @param name 合成文件名。@param revision 合成内容版本。@returns 完整的准备结果，无文件系统副作用。 */
  function asset(name: string, revision = 'one'): Insertable<AssetTable> {
    const originalPath = '/synthetic/' + name;
    return {
      ownerId,
      libraryId,
      originalPath,
      originalFileName: name,
      type: AssetType.Image,
      isExternal: true,
      checksum: createHash('sha1')
        .update('path:' + originalPath)
        .digest(),
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      contentChecksum: createHash('sha1').update(revision).digest(),
      fileCreatedAt: new Date(),
      fileModifiedAt: new Date(),
      localDateTime: new Date(),
      livePhotoVideoId: null,
    };
  }

  /** 两个消费者同时发布同路径时，只建一条资产，另一调用保留同一 ID。 */
  it('serializes duplicate publication and keeps the same asset ID', async () => {
    const prepared = asset('concurrent.png');
    const results = await Promise.all([
      repository.importExternalAssets([prepared]),
      repository.importExternalAssets([prepared]),
    ]);
    const created = results.flatMap((result) => result.created);
    expect(created).toHaveLength(1);
    expect(results.flatMap((result) => result.present)).toEqual(created);
  });

  /** 发布锁被其他会话占用时，十秒内失败并释放执行权；持有者退出后可安全重试。 */
  it('times out a blocked publication and succeeds after the blocker leaves', async () => {
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = blocker.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(${DatabaseLock.ForkIphoneBackup})`.execute(connection);
      entered();
      try {
        await waiting;
      } finally {
        await sql`select pg_advisory_unlock(${DatabaseLock.ForkIphoneBackup})`.execute(connection);
      }
    });
    await ready;
    const prepared = asset('after-lock.png');
    try {
      await expect(repository.importExternalAssets([prepared])).rejects.toMatchObject({ code: '55P03' });
      expect(
        await database.selectFrom('asset').select('id').where('originalPath', '=', prepared.originalPath).execute(),
      ).toEqual([]);
    } finally {
      release();
      await held;
    }
    expect((await repository.importExternalAssets([prepared])).created).toHaveLength(1);
  }, 20_000);

  /** 批次中途更新被阻塞时，前面的新建必须回滚；重试保留既有 ID 并完整提交。 */
  it('rolls back partial publication and releases its advisory lock on an update timeout', async () => {
    const initial = await repository.importExternalAssets([asset('existing.png')]);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = blocker.transaction().execute(async (tx) => {
      await tx.selectFrom('asset').select('id').where('id', '=', initial.created[0]).forUpdate().execute();
      entered();
      await waiting;
    });
    await ready;
    const prepared = [asset('rolled-back.png'), asset('existing.png', 'two')];
    try {
      await expect(repository.importExternalAssets(prepared)).rejects.toMatchObject({ code: '55P03' });
      expect(
        await database
          .selectFrom('asset')
          .select('id')
          .where('originalPath', '=', '/synthetic/rolled-back.png')
          .execute(),
      ).toEqual([]);
      await database.transaction().execute(async (tx) => {
        const lock = await sql<{
          available: boolean;
        }>`select pg_try_advisory_xact_lock(${DatabaseLock.ForkIphoneBackup}) as available`.execute(tx);
        expect(lock.rows[0].available).toBe(true);
      });
    } finally {
      release();
      await held;
    }
    const recovered = await repository.importExternalAssets(prepared);
    expect(recovered.created).toHaveLength(1);
    expect(recovered.updated).toEqual(initial.created);
    expect(recovered.present).toEqual(initial.created);
  }, 20_000);
});
