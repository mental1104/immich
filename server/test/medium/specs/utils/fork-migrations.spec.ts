import { sql } from 'kysely';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { down } from 'src/schema/migrations/1792213725597-AddAssetFaceAssetState.js';
import { getKyselyDB } from 'test/utils.js';

describe('Fork upstream migrations', () => {
  it('applies an older upstream migration after the existing fork migrations in production', async () => {
    const db = await getKyselyDB();
    try {
      const migration = '1792213725597-AddAssetFaceAssetState';
      // 仅回退独立测试库中的官方新迁移，模拟已经运行过 Fork 3.3.3 的数据库。
      await down(db);
      await sql`DELETE FROM kysely_migrations WHERE name = ${migration}`.execute(db);
      const before = await sql<{ name: string }>`SELECT name FROM kysely_migrations ORDER BY name`.execute(db);
      expect(before.rows.some(({ name }) => name === '1792420000000-ForkGeodataNames')).toBe(true);

      const config = new ConfigRepository();
      vi.spyOn(config, 'isDev').mockReturnValue(false);
      const sut = new DatabaseRepository(db, LoggingRepository.create(), config);
      expect(await sut.runMigrations()).toBe(1);
      expect(await sut.runMigrations()).toBe(0);

      const after = await sql<{ name: string }>`SELECT name FROM kysely_migrations ORDER BY name`.execute(db);
      expect(after.rows.map(({ name }) => name)).toEqual([...before.rows.map(({ name }) => name), migration].sort());
      await db.selectFrom('asset_face').select(['ownerId', 'assetVisibility', 'assetDeletedAt']).limit(1).execute();
      await db.selectFrom('album').select('customGroupName').limit(1).execute();
    } finally {
      await db.destroy();
      vi.restoreAllMocks();
    }
  });
});
