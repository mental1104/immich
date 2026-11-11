import { Kysely } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** 真实 PostgreSQL 验证并发提交、叠放封面以及原生资产可见范围。 */
describe('Photo edit stack append', () => {
  let db: Kysely<DB>;

  /** 克隆本套专用迁移数据库。 */
  beforeAll(async () => {
    db = await getKyselyDB();
  });

  /** 关闭隔离数据库的连接。 */
  afterAll(async () => {
    await db.destroy();
  });

  /** 待修原片可以是已有叠放的普通成员，同时提交两张成片不会重建原组。 */
  it('appends both revisions to the original stack without replacing its cover', async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const base = { ownerId: user.id, type: AssetType.Image };
    const { result: cover } = await ctx.newAsset(base);
    const { result: original } = await ctx.newAsset(base);
    const { result: first } = await ctx.newAsset({ ...base, visibility: AssetVisibility.Hidden });
    const { result: second } = await ctx.newAsset({ ...base, visibility: AssetVisibility.Hidden });
    const stacks = new StackRepository(db);
    const stack = await stacks.create({ ownerId: user.id }, [cover.id, original.id]);

    const results = await Promise.all([
      stacks.appendPhotoEdit(user.id, original.id, first.id),
      stacks.appendPhotoEdit(user.id, original.id, second.id),
    ]);
    expect(results).toEqual([
      { id: stack.id, created: false, changed: true },
      { id: stack.id, created: false, changed: true },
    ]);
    expect(await stacks.appendPhotoEdit(user.id, original.id, first.id)).toEqual({
      id: stack.id,
      created: false,
      changed: false,
    });
    const saved = await db.selectFrom('asset').select(['id', 'visibility']).where('stackId', '=', stack.id).execute();
    expect(new Set(saved.map(({ id }) => id))).toEqual(new Set([cover.id, original.id, first.id, second.id]));
    expect(saved.every(({ visibility }) => visibility === AssetVisibility.Timeline)).toBe(true);
    const record = await db.selectFrom('stack').select('primaryAssetId').where('id', '=', stack.id).executeTakeFirst();
    expect(record?.primaryAssetId).toBe(cover.id);
  });

  /** 原片未叠放时以它为封面，归档原片的成片也进入相同可见范围。 */
  it('creates a new stack with the archived original as cover', async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const base = { ownerId: user.id, type: AssetType.Image };
    const { result: original } = await ctx.newAsset({ ...base, visibility: AssetVisibility.Archive });
    const { result: edited } = await ctx.newAsset({ ...base, visibility: AssetVisibility.Hidden });
    // 原生叠放读取含 EXIF 的资产，补齐标准上传入口会先建的最小记录。
    for (const assetId of [original.id, edited.id]) {
      await ctx.get(AssetRepository).upsertExif({
        exif: { assetId, fileSizeInByte: 1 },
        lockedPropertiesBehavior: 'override',
      });
    }
    const stacks = new StackRepository(db);
    const created = await stacks.appendPhotoEdit(user.id, original.id, edited.id);
    expect(created).toMatchObject({ created: true, changed: true });
    const stack = await stacks.getById(created.id);
    expect(stack?.primaryAssetId).toBe(original.id);
    expect(stack?.assets).toHaveLength(2);
    expect(stack?.assets.every(({ visibility }) => visibility === AssetVisibility.Archive)).toBe(true);
  });
});
