import { Kysely, sql } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig, searchAssetBuilder, searchAssetBuilderLegacy } from 'src/utils/database.js';
import { phoneVideoPredicate, screenshotPredicate } from 'src/utils/media-category.js';

describe('media category SQL rules', () => {
  it('handles sizes, camera metadata, negative filters and owner-scoped search in both API shapes', async () => {
    const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: process.env.IMMICH_TEST_POSTGRES_URL! }));
    const ownerId = '11111111-1111-4111-8111-111111111111';
    try {
      await db.transaction().execute(async (tx) => {
        await sql`CREATE TEMPORARY TABLE asset (
          id text, type text, width integer, height integer, "ownerId" uuid,
          visibility text, "deletedAt" timestamptz
        ) ON COMMIT DROP`.execute(tx);
        await sql`CREATE TEMPORARY TABLE asset_exif ("assetId" text, make text, model text) ON COMMIT DROP`.execute(tx);
        const cases = [
          ['4k', 'VIDEO', 3840, 2160, 'Apple', 'iPhone 15 Pro', true, false],
          ['4k-portrait', 'VIDEO', 2160, 3840, 'Apple', 'iPhone 15 Pro', true, false],
          ['hd', 'VIDEO', 1920, 1080, 'Apple', 'iPhone XS', true, false],
          ['720p', 'VIDEO', 1280, 720, 'Apple', null, true, false],
          ['4to3', 'VIDEO', 1920, 1440, 'Apple', 'iPhone 15 Pro', true, false],
          ['3to4', 'VIDEO', 1440, 1920, 'Apple', null, true, false],
          ['scaled', 'VIDEO', 1744, 1308, 'Apple', null, true, false],
          ['model-prefix', 'VIDEO', 1920, 1080, null, 'Apple iPhone', true, false],
          ['trim-case', 'VIDEO', 1920, 1080, ' apple Inc. ', null, true, false],
          ['other-camera', 'VIDEO', 3840, 2160, 'DJI', 'Pocket 3', false, false],
          ['no-exif', 'VIDEO', 3840, 2160, null, null, false, false],
          ['square', 'VIDEO', 1080, 1080, 'Apple', null, false, false],
          ['no-width', 'VIDEO', null, 1080, 'Apple', null, false, false],
          ['zero', 'VIDEO', 0, 0, 'Apple', null, false, false],
          ['wrong-type', 'IMAGE', 3840, 2160, 'Apple', null, false, false],
          ['screenshot', 'IMAGE', 1179, 2556, null, null, false, true],
          ['screenshot-with-camera', 'IMAGE', 1179, 2556, 'Apple', 'iPhone', false, true],
          ['landscape-image', 'IMAGE', 2556, 1179, null, null, false, false],
          ['different-size', 'IMAGE', 1178, 2556, null, null, false, false],
          ['video-not-screenshot', 'VIDEO', 1179, 2556, 'Apple', null, false, false],
          ['missing-size', 'IMAGE', null, null, null, null, false, false],
        ] as const;

        for (const [id, type, width, height, make, model] of cases) {
          await sql`INSERT INTO asset VALUES (${id},${type},${width},${height},${ownerId}::uuid,'timeline',null)`.execute(
            tx,
          );
          if (make !== null || model !== null) {
            await sql`INSERT INTO asset_exif VALUES (${id},${make},${model})`.execute(tx);
          }
        }

        for (const [predicate, flag, position] of [
          [phoneVideoPredicate, 'isPhoneVideo', 6],
          [screenshotPredicate, 'isScreenshot', 7],
        ] as const) {
          const expected = cases
            .filter((row) => row[position])
            .map((row) => row[0])
            .toSorted();
          const matched = await tx.selectFrom('asset').select('id').where(predicate()).execute();
          const excluded = await tx
            .selectFrom('asset')
            .select('id')
            .where((eb) => eb.not(predicate()))
            .execute();
          expect(matched.map((row) => row.id).toSorted()).toEqual(expected);
          expect(excluded.map((row) => row.id).toSorted()).toEqual(
            cases
              .filter((row) => !row[position])
              .map((row) => row[0])
              .toSorted(),
          );
          const legacy = await searchAssetBuilderLegacy(tx, {
            [flag]: true,
            userIds: [ownerId],
            visibility: AssetVisibility.Timeline,
          })
            .select('asset.id')
            .execute();
          const structured = await searchAssetBuilder(
            tx,
            {
              filter: { [flag]: { eq: true }, visibility: { eq: AssetVisibility.Timeline } },
            },
            { userIds: [ownerId], lockedOwnerId: ownerId },
          )
            .select('asset.id')
            .execute();
          expect(legacy.map((row) => row.id).toSorted()).toEqual(expected);
          expect(structured.map((row) => row.id).toSorted()).toEqual(expected);
        }

        await sql`INSERT INTO asset VALUES ('other-owner','VIDEO',3840,2160,
          '22222222-2222-4222-8222-222222222222'::uuid,'timeline',null)`.execute(tx);
        await sql`INSERT INTO asset_exif VALUES ('other-owner','Apple','iPhone')`.execute(tx);
        const options = { filter: { or: [{ isPhoneVideo: { eq: true } }, { isScreenshot: { eq: true } }] } };
        const union = await searchAssetBuilder(tx, options, { userIds: [ownerId], lockedOwnerId: ownerId })
          .select('asset.id')
          .execute();
        expect(union.map((row) => row.id).toSorted()).toEqual(
          cases
            .filter((row) => row[6] || row[7])
            .map((row) => row[0])
            .toSorted(),
        );
      });
    } finally {
      await db.destroy();
    }
  });
});
