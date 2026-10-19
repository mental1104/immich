import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';

/** 使用连接私有临时表验证配对事务，避免修改测试库中的真实资产。 */
describe('RAW rendered-image pairing', () => {
  /** NEF/DNG 与 JPG/HEIC/HEIF 均可唯一配对；歧义或参数不同则不合并。 */
  it('pairs supported RAW and rendered formats only for matching captures', async () => {
    const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: process.env.IMMICH_TEST_POSTGRES_URL! }));
    try {
      await db.connection().execute(async (connection) => {
        await sql`create temporary table asset (
          id uuid primary key, "ownerId" uuid, "libraryId" uuid, "stackId" uuid, "isExternal" boolean,
          type text, visibility text, "originalPath" text, "originalFileName" text,
          "deletedAt" timestamp, "updatedAt" timestamp
        )`.execute(connection);
        await sql`create temporary table asset_exif (
          "assetId" uuid primary key, make text, model text, "dateTimeOriginal" timestamptz,
          "exposureTime" text, "fNumber" double precision, "focalLength" double precision, iso integer
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
        /** 创建拍摄参数相同但文件名和目录不同、尚未堆叠的一对文件，无返回值。 */
        const seed = async (
          rawFilename = 'NIKON_RAW.NEF',
          renderedFilename = 'edited-export.JPG',
          model = 'NIKON Z5_2',
          rawMake = 'NIKON CORPORATION',
          renderedMake = rawMake,
        ) => {
          await sql`truncate pg_temp.asset, pg_temp.asset_exif, pg_temp.stack`.execute(connection);
          for (const [id, filename, folder] of [
            [rawId, rawFilename, 'raw'],
            [jpgId, renderedFilename, 'rendered'],
          ]) {
            await sql`insert into asset (id,"ownerId","libraryId","isExternal",type,visibility,"originalPath","originalFileName")
              values (${id},${ownerId},${libraryId},true,'IMAGE','timeline',${`/library/${folder}/${filename}`},${filename})`.execute(
              connection,
            );
            const make = id === rawId ? rawMake : renderedMake;
            await sql`insert into asset_exif values (${id},${make},${model},${capturedAt},'1/125',2.8,50,400)`.execute(
              connection,
            );
          }
        };

        for (const [rawFilename, renderedFilename] of [
          ['NIKON_RAW.NEF', 'edited-export.JPG'],
          ['camera.DNG', 'camera.jpg'],
          ['camera.NEF', 'camera.HEIC'],
          ['camera.DNG', 'camera.HEIF'],
          ['camera.NEF', 'camera.jpeg'],
          ['camera.DNG', 'camera.heic'],
        ]) {
          const isDng = rawFilename.toLowerCase().endsWith('.dng');
          await seed(
            rawFilename,
            renderedFilename,
            isDng ? 'LEICA M11' : 'NIKON Z5_2',
            isDng ? 'ADOBE' : 'NIKON CORPORATION',
            isDng ? 'LEICA CAMERA AG' : 'NIKON CORPORATION',
          );
          const stackId = await sut.autoStackRawPair(rawId, ownerId);
          expect(stackId).toBeDefined();
          expect(await connection.selectFrom('stack').select('primaryAssetId').executeTakeFirst()).toEqual({
            primaryAssetId: jpgId,
          });
          expect(await sut.autoStackRawPair(jpgId, ownerId)).toBeUndefined();
          expect(await connection.selectFrom('stack').selectAll().execute()).toHaveLength(1);
        }

        const mismatches = [
          sql`update asset set "ownerId"=${randomUUID()} where id=${jpgId}`,
          sql`update asset set "libraryId"=${randomUUID()} where id=${jpgId}`,
          sql`update asset_exif set "dateTimeOriginal"="dateTimeOriginal"+interval '1 second' where "assetId"=${jpgId}`,
          sql`update asset_exif set model='NIKON Z6' where "assetId"=${jpgId}`,
          sql`update asset_exif set "dateTimeOriginal"=null where "assetId"=${rawId}`,
          sql`update asset_exif set "exposureTime"='1/250' where "assetId"=${jpgId}`,
          sql`update asset_exif set "fNumber"=4 where "assetId"=${jpgId}`,
          sql`update asset_exif set "focalLength"=85 where "assetId"=${jpgId}`,
          sql`update asset_exif set iso=800 where "assetId"=${jpgId}`,
          sql`update asset_exif set "exposureTime"=null where "assetId"=${rawId}`,
          sql`update asset_exif set "fNumber"=null where "assetId"=${rawId}`,
          sql`update asset_exif set "focalLength"=null where "assetId"=${rawId}`,
          sql`update asset_exif set iso=null where "assetId"=${rawId}`,
          sql`update asset set "stackId"=${randomUUID()} where id=${jpgId}`,
          sql`update asset set visibility='archive' where id=${jpgId}`,
          sql`update asset set "deletedAt"=now() where id=${jpgId}`,
        ];
        for (const change of mismatches) {
          await seed();
          await change.execute(connection);
          expect(await sut.autoStackRawPair(rawId, ownerId)).toBeUndefined();
          expect(await connection.selectFrom('stack').selectAll().execute()).toEqual([]);
        }
        await seed();
        const duplicateId = randomUUID();
        await sql`insert into asset select ${duplicateId},"ownerId","libraryId","stackId","isExternal",type,visibility,"originalPath","originalFileName","deletedAt","updatedAt" from asset where id=${jpgId}`.execute(
          connection,
        );
        await sql`insert into asset_exif select ${duplicateId},make,model,"dateTimeOriginal","exposureTime","fNumber","focalLength",iso from asset_exif where "assetId"=${jpgId}`.execute(
          connection,
        );
        expect(await sut.autoStackRawPair(rawId, ownerId)).toBeUndefined();
        await sql`drop table pg_temp.asset, pg_temp.asset_exif, pg_temp.stack`.execute(connection);
      });
    } finally {
      await db.destroy();
    }
  });
});
