import { Kysely, sql } from 'kysely';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { panoramaPredicate } from 'src/utils/panorama.js';

/** 在测试数据库的事务临时表中验证全景 SQL；提交时自动删除临时表，不改真实资产。 */
describe('panorama search predicate', () => {
  /** 覆盖扩展名、可靠投影、受限 JPG 回退，以及反向筛选中的 NULL 语义。 */
  it('matches only supported panorama evidence and preserves normal assets when negated', async () => {
    const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: process.env.IMMICH_TEST_POSTGRES_URL! }));
    try {
      await db.transaction().execute(async (trx) => {
        await sql`create temporary table asset (id text, type text, "originalFileName" text) on commit drop`.execute(
          trx,
        );
        await sql`create temporary table asset_exif (
          "assetId" text, "projectionType" text, make text, model text,
          "exifImageWidth" integer, "exifImageHeight" integer
        ) on commit drop`.execute(trx);

        const cases = [
          ['insp', 'IMAGE', 'source.INSP', null, null, null, null, null, true],
          ['insv', 'VIDEO', 'source.insv', null, null, null, null, null, true],
          ['jpg-metadata', 'IMAGE', 'export.jpg', 'EQUIRECTANGULAR', null, null, 4000, 2000, true],
          ['mp4-metadata', 'VIDEO', 'export.MP4', 'equirectangular', null, null, 7680, 3840, true],
          ['x5-jpg', 'IMAGE', 'export.JPEG', null, 'Arashi Vision', 'Insta360 X5', 11_904, 5952, true],
          ['normal-no-exif', 'IMAGE', 'normal.jpg', null, null, null, null, null, false],
          ['ordinary-2to1', 'IMAGE', 'normal.jpg', null, null, null, 11_904, 5952, false],
          ['mp4-no-metadata', 'VIDEO', 'export.mp4', null, 'Arashi Vision', 'Insta360 X5', 7680, 3840, false],
          ['other-model', 'IMAGE', 'export.jpg', null, 'Arashi Vision', 'Insta360 X4', 11_904, 5952, false],
          ['other-size', 'IMAGE', 'export.jpg', null, 'Arashi Vision', 'Insta360 X5', 7680, 3840, false],
          ['explicit-fisheye', 'IMAGE', 'export.jpg', 'FISHEYE', 'Arashi Vision', 'Insta360 X5', 11_904, 5952, false],
          ['not-extension', 'IMAGE', 'not-insp', null, null, null, null, null, false],
          ['wrong-type', 'IMAGE', 'source.insv', null, null, null, null, null, false],
          ['png', 'IMAGE', 'export.png', null, 'Arashi Vision', 'Insta360 X5', 11_904, 5952, false],
        ] as const;
        for (const [id, type, filename, projection, make, model, width, height] of cases) {
          await sql`insert into asset values (${id}, ${type}, ${filename})`.execute(trx);
          // 单独保留完全没有 EXIF 行的资产，确保 EXISTS 不会把反向筛选变成 NULL。
          if (id !== 'normal-no-exif') {
            await sql`insert into asset_exif values (${id}, ${projection}, ${make}, ${model}, ${width}, ${height})`.execute(
              trx,
            );
          }
        }
        const matched = await trx.selectFrom('asset').select('id').where(panoramaPredicate()).execute();
        const excluded = await trx
          .selectFrom('asset')
          .select('id')
          .where((eb) => eb.not(panoramaPredicate()))
          .execute();
        expect(matched.map(({ id }) => id).toSorted()).toEqual(
          cases
            .filter((row) => row[8])
            .map((row) => row[0])
            .toSorted(),
        );
        expect(excluded.map(({ id }) => id).toSorted()).toEqual(
          cases
            .filter((row) => !row[8])
            .map((row) => row[0])
            .toSorted(),
        );
      });
    } finally {
      await db.destroy();
    }
  });
});
