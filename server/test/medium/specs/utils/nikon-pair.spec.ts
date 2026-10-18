import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';

/** 使用连接私有临时表验证配对事务，避免修改测试库中的真实资产。 */
describe('Nikon RAW JPEG pairing', () => {
  /** 唯一同次拍摄配对以 JPEG 为封面，重复处理保持幂等，各类歧义均不合并。 */
  it('pairs only matching captures and preserves existing or ambiguous groups', async () => {
    const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: process.env.IMMICH_TEST_POSTGRES_URL! }));
    try {
      await db.connection().execute(async (connection) => {
        await sql`create temporary table asset (
          id uuid primary key, "ownerId" uuid, "libraryId" uuid, "stackId" uuid, "isExternal" boolean,
          type text, visibility text, "originalPath" text, "originalFileName" text,
          "deletedAt" timestamp, "updatedAt" timestamp
        )`.execute(connection);
        await sql`create temporary table asset_exif (
          "assetId" uuid primary key, make text, model text, "dateTimeOriginal" timestamptz
        )`.execute(connection);
        await sql`create temporary table stack (id uuid default gen_random_uuid(), "ownerId" uuid, "primaryAssetId" uuid)`.execute(
          connection,
        );
        const sut = new StackRepository(connection);
        const ownerId = randomUUID();
        const libraryId = randomUUID();
        const rawId = randomUUID();
        const jpgId = randomUUID();
        const capturedAt = new Date('2026-01-01T01:02:03.400Z');
        /** 创建同目录、同相机、同时间且尚未堆叠的一对文件，无返回值。 */
        const seed = async () => {
          await sql`truncate pg_temp.asset, pg_temp.asset_exif, pg_temp.stack`.execute(connection);
          for (const [id, filename] of [
            [rawId, 'DSC_1234.NEF'],
            [jpgId, 'DSC_1234.JPG'],
          ]) {
            await sql`insert into asset (id,"ownerId","libraryId","isExternal",type,visibility,"originalPath","originalFileName")
              values (${id},${ownerId},${libraryId},true,'IMAGE','timeline',${`/library/trip/${filename}`},${filename})`.execute(
              connection,
            );
            await sql`insert into asset_exif values (${id},'NIKON CORPORATION','NIKON Z5_2',${capturedAt})`.execute(
              connection,
            );
          }
        };

        await seed();
        const stackId = await sut.autoStackNikonPair(rawId, ownerId);
        expect(stackId).toBeDefined();
        expect(await connection.selectFrom('stack').select('primaryAssetId').executeTakeFirst()).toEqual({
          primaryAssetId: jpgId,
        });
        expect(await sut.autoStackNikonPair(jpgId, ownerId)).toBeUndefined();
        const stacks = await connection.selectFrom('stack').selectAll().execute();
        expect(stacks).toHaveLength(1);

        const mismatches = [
          sql`update asset set "ownerId"=${randomUUID()} where id=${jpgId}`,
          sql`update asset set "libraryId"=${randomUUID()} where id=${jpgId}`,
          sql`update asset set "originalPath"='/library/other/DSC_1234.JPG' where id=${jpgId}`,
          sql`update asset_exif set "dateTimeOriginal"="dateTimeOriginal"+interval '1 second' where "assetId"=${jpgId}`,
          sql`update asset_exif set model='NIKON Z6' where "assetId"=${jpgId}`,
          sql`update asset_exif set make='Other' where "assetId"=${rawId}`,
          sql`update asset_exif set "dateTimeOriginal"=null where "assetId"=${rawId}`,
          sql`update asset set "originalFileName"='DSC_9999.JPG' where id=${jpgId}`,
          sql`update asset set "stackId"=${randomUUID()} where id=${jpgId}`,
          sql`update asset set visibility='archive' where id=${jpgId}`,
          sql`update asset set "deletedAt"=now() where id=${jpgId}`,
        ];
        for (const change of mismatches) {
          await seed();
          await change.execute(connection);
          expect(await sut.autoStackNikonPair(rawId, ownerId)).toBeUndefined();
          expect(await connection.selectFrom('stack').selectAll().execute()).toEqual([]);
        }
        await seed();
        const duplicateId = randomUUID();
        await sql`insert into asset select ${duplicateId},"ownerId","libraryId","stackId","isExternal",type,visibility,"originalPath","originalFileName","deletedAt","updatedAt" from asset where id=${jpgId}`.execute(
          connection,
        );
        await sql`insert into asset_exif select ${duplicateId},make,model,"dateTimeOriginal" from asset_exif where "assetId"=${jpgId}`.execute(
          connection,
        );
        expect(await sut.autoStackNikonPair(rawId, ownerId)).toBeUndefined();
        await sql`drop table pg_temp.asset, pg_temp.asset_exif, pg_temp.stack`.execute(connection);
      });
    } finally {
      await db.destroy();
    }
  });
});
