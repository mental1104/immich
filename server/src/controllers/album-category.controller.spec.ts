import { UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { AlbumCategoryController } from 'src/controllers/album-category.controller.js';
import { AlbumCategoryService } from 'src/services/album-category.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newUuid } from 'test/small.factory.js';
import { controllerSetup, type ControllerContext } from 'test/utils.js';

/** 经Nest HTTP边界验证个人目录鉴权、输入约束及不可由客户端指定用户。 */
describe(AlbumCategoryController.name, () => {
  const auth = AuthFactory.from().session().build();
  const category = { id: newUuid(), name: 'Travel' };
  const service = { getState: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn(), assign: vi.fn() };
  let ctx: ControllerContext;

  /** 创建带真实DTO管线的控制器；持久化在独立数据库用例覆盖。 */
  beforeAll(async () => {
    ctx = await controllerSetup(AlbumCategoryController, [{ provide: AlbumCategoryService, useValue: service }]);
  });
  /** 每次请求以当前登录用户为身份来源，清除上一用例行为。 */
  beforeEach(() => {
    ctx.reset();
    vi.clearAllMocks();
    ctx.authenticate.mockResolvedValue(auth);
  });
  /** 释放测试HTTP应用。 */
  afterAll(async () => {
    await ctx.close();
  });

  /** 未认证请求在业务执行之前拒绝。 */
  it('rejects anonymous requests', async () => {
    ctx.authenticate.mockRejectedValue(new UnauthorizedException());
    await request(ctx.getHttpServer()).get('/fork/album-categories').expect(401);
    expect(service.getState).not.toHaveBeenCalled();
  });

  /** 输入中的其他账号ID不能改变查询范围。 */
  it('reads only the authenticated user directory', async () => {
    service.getState.mockResolvedValue({ categories: [], groups: [] });
    await request(ctx.getHttpServer())
      .get('/fork/album-categories')
      .query({ userId: newUuid() })
      .expect(200, { categories: [], groups: [] });
    expect(service.getState).toHaveBeenCalledWith(auth.user.id);
  });

  /** 名称会清除首尾空白，目录所属用户由认证上下文决定。 */
  it('creates a category with a trimmed name', async () => {
    service.create.mockResolvedValue(category);
    await request(ctx.getHttpServer())
      .post('/fork/album-categories')
      .send({ name: '  Travel  ', userId: newUuid() })
      .expect(201, category);
    expect(service.create).toHaveBeenCalledWith(auth.user.id, 'Travel');
  });

  /** 空名称、无效UUID和缺失大组值不得进入持久化。 */
  it('rejects invalid directory commands', async () => {
    await request(ctx.getHttpServer()).post('/fork/album-categories').send({ name: ' ' }).expect(400);
    await request(ctx.getHttpServer())
      .put('/fork/album-categories/group')
      .send({ groupName: 'Region', categoryId: 'invalid' })
      .expect(400);
    await request(ctx.getHttpServer()).put('/fork/album-categories/group').send({ groupName: 'Region' }).expect(400);
    await request(ctx.getHttpServer()).patch('/fork/album-categories/invalid').send({ name: 'New' }).expect(400);
    expect(service.assign).not.toHaveBeenCalled();
  });

  /** 回默认通过null表达，未分组的空名称也可具有可选父归属。 */
  it('resets a group to the virtual default without rewriting albums', async () => {
    await request(ctx.getHttpServer())
      .put('/fork/album-categories/group')
      .send({ groupName: '', categoryId: null })
      .expect(204);
    expect(service.assign).toHaveBeenCalledWith(auth.user.id, { groupName: '', categoryId: null });
  });
});
