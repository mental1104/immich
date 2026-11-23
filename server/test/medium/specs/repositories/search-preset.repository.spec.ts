import type { Kysely } from 'kysely';
import request from 'supertest';
import { SearchPresetController } from 'src/controllers/search-preset.controller.js';
import { SearchPresetRepository } from 'src/repositories/search-preset.repository.js';
import type { DB } from 'src/schema/index.js';
import { SearchPresetService } from 'src/services/search-preset.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { controllerSetup, getKyselyDB, type ControllerContext } from 'test/utils.js';

/** 用真实PG和HTTP/DTO边界验证登记持久化、输入约束与账号隔离；认证身份由独立夹具注入。 */
describe('Search preset HTTP integration', () => {
  let db: Kysely<DB>;
  let app: ControllerContext;
  const first = UserFactory.create({ email: 'first@presets.invalid' });
  const second = UserFactory.create({ email: 'second@presets.invalid' });
  const auth = AuthFactory.from(first).session().build();

  /** 创建隔离测试库和真实登记服务，避免把JSON只保存在控制器替身中。 */
  beforeAll(async () => {
    db = await getKyselyDB();
    await db
      .insertInto('cluster_group')
      .values([{ id: first.clusterGroupId }, { id: second.clusterGroupId }])
      .execute();
    // UserFactory的metadata是读取关系，不是user列；只写实体字段。
    await db
      .insertInto('user')
      .values([first, second].map(({ metadata: _, ...user }) => user))
      .execute();
    app = await controllerSetup(SearchPresetController, [
      { provide: SearchPresetService, useValue: new SearchPresetService(new SearchPresetRepository(db)) },
    ]);
  });
  /** 每个用例从第一个账号发起，跨账号场景显式切换身份。 */
  beforeEach(() => {
    app.reset();
    app.authenticate.mockResolvedValue(auth);
  });
  /** 关闭HTTP应用与测试库连接。 */
  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  /** 只保存勾选条件，重新创建仓库仍能读取；另一账号无法读写其ID。 */
  it('persists selected conditions without exposing them to another account', async () => {
    const conditions = { mediaType: 'video', exifConditions: [{ field: 'iso', operator: 'gte', value: 800 }] };
    const created = await request(app.getHttpServer())
      .post('/fork/search-presets')
      .send({ name: '  Low light  ', conditions, userId: second.id })
      .expect(201);
    const id = created.body.id as string;
    expect(await new SearchPresetRepository(db).getAll(first.id)).toEqual([{ id, name: 'Low light', conditions }]);
    app.authenticate.mockResolvedValue(AuthFactory.from(second).session().build());
    await request(app.getHttpServer()).get('/fork/search-presets').expect(200, []);
    await request(app.getHttpServer())
      .patch(`/fork/search-presets/${id}`)
      .send({ name: 'Stolen', conditions })
      .expect(404);
    await request(app.getHttpServer()).delete(`/fork/search-presets/${id}`).expect(404);
    app.authenticate.mockResolvedValue(auth);
    await request(app.getHttpServer())
      .patch(`/fork/search-presets/${id}`)
      .send({ name: 'Updated', conditions: { isFavorite: true } })
      .expect(200);
    expect(await new SearchPresetRepository(db).getAll(first.id)).toEqual([
      { id, name: 'Updated', conditions: { isFavorite: true } },
    ]);
    await request(app.getHttpServer()).delete(`/fork/search-presets/${id}`).expect(204);
    await request(app.getHttpServer()).get('/fork/search-presets').expect(200, []);
  });

  /** 不允许空条件、任意查询树、用户范围、无效日期或非法数值进入登记表。 */
  it('rejects non-atomic or malformed conditions and duplicate names', async () => {
    const server = app.getHttpServer();
    for (const conditions of [
      {},
      { userIds: [second.id] },
      { filter: { or: [] } },
      { takenAfter: 'tomorrow' },
      { exifConditions: [{ field: 'iso', operator: 'gte', value: -1 }] },
    ]) {
      await request(server).post('/fork/search-presets').send({ name: 'Invalid', conditions }).expect(400);
    }
    await request(server)
      .post('/fork/search-presets')
      .send({ name: 'Duplicate', conditions: { rating: null } })
      .expect(201);
    await request(server)
      .post('/fork/search-presets')
      .send({ name: 'Duplicate', conditions: { isFavorite: true } })
      .expect(409);
    await request(server)
      .patch('/fork/search-presets/invalid')
      .send({ name: 'Invalid', conditions: { isFavorite: true } })
      .expect(400);
  });
});
