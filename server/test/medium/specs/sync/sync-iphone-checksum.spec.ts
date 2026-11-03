import { schemaDiff, schemaFromCode, schemaFromDatabase } from '@immich/sql-tools';
import { Insertable, Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { immich_uuid_v7 } from 'src/schema/functions.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/1793718000000-ForkIphoneClientChecksum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { SyncTestContext } from 'test/medium.factory.js';

import { getKyselyDB } from 'test/utils.js';

/** 真实 PostgreSQL 同步响应进入内存 SQLite，覆盖官方客户端同库内容唯一索引。 */
describe('external library client checksum compatibility', () => {
  let database: Kysely<DB>;
  let context: SyncTestContext;
  let auth: Awaited<ReturnType<SyncTestContext['newSyncAuthUser']>>['auth'];
  let libraryId: string;
  let sqlite: DatabaseSync;
  const checksum = createHash('sha1').update('synthetic-shared-content').digest();

  /** 每例创建独立数据库、用户和外部库，避免迁移回退及会话重置影响其他场景。 */
  beforeEach(async () => {
    database = await getKyselyDB();
    context = new SyncTestContext(database);
    ({ auth } = await context.newSyncAuthUser());
    const library = await context
      .get(LibraryRepository)
      .create({ ownerId: auth.user.id, name: 'Synthetic checksum test', importPaths: [], exclusionPatterns: [] });
    libraryId = library.id;
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', libraryId);
    vi.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', '/synthetic/backup');
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE remote_asset_entity (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, library_id TEXT, checksum TEXT NOT NULL);
      CREATE UNIQUE INDEX UQ_remote_assets_owner_library_checksum
      ON remote_asset_entity(owner_id, library_id, checksum) WHERE library_id IS NOT NULL;
    `);
  });

  /** 释放合成数据库及内存索引，不访问生产数据库或原片。 */
  afterEach(async () => {
    sqlite?.close();
    await database?.destroy();
    vi.unstubAllEnvs();
  });

  /**
   * @param options 覆盖合成资产的内容、库或状态；默认与其他资产内容相同、路径身份不同。
   * @returns 已由真实数据库触发器分配客户端指纹的资产，不创建原片。
   */
  async function addAsset(options: Partial<Insertable<AssetTable>> = {}) {
    const { asset } = await context.newAsset({
      ownerId: auth.user.id,
      libraryId,
      isExternal: true,
      checksum: createHash('sha1').update(`synthetic-path:${randomUUID()}`).digest(),
      contentChecksum: checksum,
      ...options,
    });
    return (await context.get(AssetRepository).getById(asset.id))!;
  }

  /**
   * 把同步事件应用到官方手机使用的唯一索引和按 ID 更新逻辑。
   * @param events 原有 AssetsV2 接口响应；删除先移除记录，更新保留各自资产 ID。
   * @returns 无返回值；唯一约束冲突直接使测试失败，不忽略 SQL 错误。
   */
  function applySync(events: Awaited<ReturnType<SyncTestContext['syncStream']>>) {
    const insert = sqlite.prepare(`
      INSERT OR REPLACE INTO remote_asset_entity(id, owner_id, library_id, checksum) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, library_id=excluded.library_id, checksum=excluded.checksum
    `);
    for (const event of events) {
      if (event.type === SyncEntityType.AssetV2) {
        insert.run(event.data.id, event.data.ownerId, event.data.libraryId, event.data.checksum);
      } else if (event.type === SyncEntityType.AssetDeleteV1) {
        sqlite.prepare('DELETE FROM remote_asset_entity WHERE id = ?').run(event.data.assetId);
      }
    }
  }

  /** 同内容副本保持独立资产，列表和同步使用一致映射，且手机可确认并继续增量同步。 */
  it('keeps duplicate assets and exposes exactly one content match accepted by the mobile index', async () => {
    const first = await addAsset();
    const second = await addAsset();
    expect(first.clientChecksum).toEqual(checksum);
    expect(second.clientChecksum).toBeNull();
    const response = await context.syncStream(auth, [SyncRequestType.AssetsV2]);
    applySync(response);
    expect(sqlite.prepare('SELECT count(*) AS count FROM remote_asset_entity').get()).toEqual({ count: 2 });
    expect(
      sqlite
        .prepare('SELECT count(*) AS count FROM remote_asset_entity WHERE checksum = ?')
        .get(checksum.toString('base64')),
    ).toEqual({ count: 1 });
    const repository = context.get(AssetRepository);
    for (const asset of [first, second]) {
      const stored = (await repository.getById(asset.id))!;
      expect(stored.contentChecksum).toEqual(checksum);
      expect(stored.checksum).toEqual(asset.checksum);
      expect(response).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({ id: asset.id, checksum: mapAsset(stored).checksum }),
        }),
      );
    }
    expect(await repository.getUploadAssetIdByChecksum(auth.user.id, checksum)).toBe(first.id);
    const matches = await repository.getByChecksums(auth.user.id, [checksum]);
    expect(matches.at(-1)?.id).toBe(first.id);
    await context.syncAckAll(auth, response);
    await context.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  /** 后到副本即使 ID 或创建时间更小，也不能夺走已同步的内容指纹。 */
  it('keeps the existing representative when an earlier-sorting duplicate is added later', async () => {
    const first = await addAsset({ id: 'f0000000-0000-4000-8000-000000000001' });
    const response = await context.syncStream(auth, [SyncRequestType.AssetsV2]);
    applySync(response);
    await context.syncAckAll(auth, response);
    const second = await addAsset({ id: '00000000-0000-4000-8000-000000000001', createdAt: new Date('2020-01-01') });
    expect(second.clientChecksum).toBeNull();
    const changes = await context.syncStream(auth, [SyncRequestType.AssetsV2]);
    applySync(changes);
    expect(changes.filter((event) => event.type === SyncEntityType.AssetV2)).toHaveLength(1);
    expect((await context.get(AssetRepository).getById(first.id))!.clientChecksum).toEqual(checksum);
  });

  /** @param action 旧代表的状态变化；必须先撤销旧映射，再使新代表进入增量流。 */
  it.each(['offline', 'trash', 'delete', 'change'] as const)(
    'promotes a remaining copy safely after %s',
    async (action) => {
      const first = await addAsset();
      const second = await addAsset();
      const original = await context.syncStream(auth, [SyncRequestType.AssetsV2]);
      applySync(original);
      await context.syncAckAll(auth, original);
      const repository = context.get(AssetRepository);
      if (action === 'delete') {
        await repository.remove({ id: first.id });
      } else {
        await repository.update({
          id: first.id,
          ...(action === 'offline'
            ? { isOffline: true }
            : action === 'trash'
              ? { deletedAt: new Date() }
              : { contentChecksum: createHash('sha1').update('changed-content').digest() }),
        });
      }
      expect((await repository.getById(second.id))!.clientChecksum).toEqual(checksum);
      const changes = await context.syncStream(auth, [SyncRequestType.AssetsV2]);
      applySync(changes);
      await context.syncAckAll(auth, changes);
      await context.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
    },
  );

  /** 后台并发补算相同内容时仅一项获得匹配资格，另一项仍成功保存原始内容指纹。 */
  it('serializes concurrent fingerprint writes without losing either asset', async () => {
    const first = await addAsset({ contentChecksum: null });
    const second = await addAsset({ contentChecksum: null });
    await Promise.all([
      database.updateTable('asset').set({ contentChecksum: checksum }).where('id', '=', first.id).execute(),
      database.updateTable('asset').set({ contentChecksum: checksum }).where('id', '=', second.id).execute(),
    ]);
    const rows = await database
      .selectFrom('asset')
      .select(['contentChecksum', 'clientChecksum'])
      .where('libraryId', '=', libraryId)
      .execute();
    expect(rows.filter((row) => row.clientChecksum?.equals(checksum))).toHaveLength(1);
    expect(rows.every((row) => row.contentChecksum?.equals(checksum))).toBe(true);
    applySync(await context.syncStream(auth, [SyncRequestType.AssetsV2]));
  });

  /** 相同内容在其他库和其他用户中独立选择代表；不会扩大权限或合并记录。 */
  it('isolates checksum ownership by user and library', async () => {
    const first = await addAsset();
    expect(first.clientChecksum).toEqual(checksum);
    const library = await context
      .get(LibraryRepository)
      .create({ ownerId: auth.user.id, name: 'Other synthetic library', importPaths: [], exclusionPatterns: [] });
    const otherLibraryAsset = await addAsset({ libraryId: library.id });
    expect(otherLibraryAsset.clientChecksum).toEqual(checksum);
    const { user } = await context.newUser();
    const otherUserAsset = await addAsset({ ownerId: user.id });
    expect(otherUserAsset.clientChecksum).toEqual(checksum);
  });

  /** 旧版数据迁移保留原始指纹，并仅对受影响用户走官方远端索引重置及确认流程。 */
  it('migrates existing duplicates, resets affected sessions and preserves the schema contract', async () => {
    const first = await addAsset();
    const second = await addAsset({ createdAt: new Date('2020-01-01') });
    applySync(await context.syncStream(auth, [SyncRequestType.AssetsV2]));
    const { auth: unrelated } = await context.newSyncAuthUser();
    await database.transaction().execute(async (transaction) => {
      // 模拟旧版库再升级，不对线上数据库执行迁移。
      await down(transaction);
      await up(transaction);
    });
    const rows = await database
      .selectFrom('asset')
      .select(['id', 'contentChecksum', 'checksum', 'clientChecksum'])
      .where('libraryId', '=', libraryId)
      .execute();
    expect(rows.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    expect(rows.every((row) => row.contentChecksum?.equals(checksum))).toBe(true);
    expect(rows.filter((row) => row.clientChecksum?.equals(checksum))).toHaveLength(1);
    const reset = await context.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(reset).toEqual([{ type: SyncEntityType.SyncResetV1, data: {}, ack: 'SyncResetV1|reset' }]);
    // 官方手机先清空远端索引，再确认重置；旧代表与迁移选定的新代表可能不同。
    sqlite.exec('DELETE FROM remote_asset_entity');
    await context.syncAckAll(auth, reset);
    const response = await context.syncStream(auth, [SyncRequestType.AssetsV2]);
    applySync(response);
    await context.syncAckAll(auth, response);
    await context.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
    await context.assertSyncIsComplete(unrelated, [SyncRequestType.AssetsV2]);
    const expected = schemaFromCode({ overrides: true, namingStrategy: 'default' }).overrides.find(
      (item) => item.name === 'index_fork_asset_client_checksum_idx',
    );
    const actual = await sql<{
      value: unknown;
    }>`SELECT value FROM migration_overrides WHERE name = 'index_fork_asset_client_checksum_idx'`.execute(database);
    expect(actual.rows[0].value).toEqual(expected?.value);
    const { rows: databases } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(database);
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = databases[0].name;
    const target = await schemaFromDatabase({ connection: { connectionType: 'url', url: url.href } });
    const source = schemaFromCode({
      overrides: true,
      namingStrategy: 'default',
      uuidFunction: (version) => (version === 7 ? `${immich_uuid_v7.name}()` : 'uuid_generate_v4()'),
    });
    for (const definition of source.overrides) {
      if (definition.name.startsWith('function_fork_iphone')) {
        expect(target.overrides.find((item) => item.name === definition.name)?.value).toEqual(definition.value);
      }
    }
    const drift = schemaDiff(source, target)
      .asHuman()
      .filter((line) => /clientChecksum|fork_iphone|asset_fork_iphone|fork_asset_client/.test(line));
    expect(drift).toEqual([]);
  });
});
