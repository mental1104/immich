import type { Kysely } from 'kysely';
import type { Server } from 'node:http';
import { AlbumCategoryController } from 'src/controllers/album-category.controller.js';
import { SearchController } from 'src/controllers/search.controller.js';
import type { MetadataSearchDto, SmartSearchDto } from 'src/dtos/search.dto.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumCategoryRepository } from 'src/repositories/album-category.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import type { DB } from 'src/schema/index.js';
import { AlbumCategoryService } from 'src/services/album-category.service.js';
import { SearchService } from 'src/services/search.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

/** 使用真实PG和真实查询，覆盖可选大组、目录OR匹配及两代搜索请求。 */
describe('Album category search integration', () => {
  let db: Kysely<DB>;

  /** 每个文件使用从已迁移空模板克隆的独立库，不接触真实图库。 */
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  /** 关闭测试连接，临时数据库随维护任务清理。 */
  afterAll(async () => {
    await db.destroy();
  });

  /** @returns 有真实相簿、资产及权限仓库的搜索上下文和个人目录服务。 */
  function setup() {
    const context = newMediumService(SearchService, {
      database: db,
      real: [AccessRepository, AlbumRepository, AssetRepository, SearchRepository, PartnerRepository],
      mock: [LoggingRepository],
    });
    const categories = new AlbumCategoryRepository(db);
    return { ...context, categories, service: new AlbumCategoryService(categories) };
  }

  /** 经真实HTTP和DTO管线调用创建、归属及两种官方搜索；认证身份由夹具注入，图库和查询均为真实PG。 */
  it('exposes category matching through both existing HTTP search shapes', async () => {
    const { ctx, sut, service } = setup();
    const { user } = await ctx.newUser();
    const auth = AuthFactory.from({ id: user.id }).session().build();
    const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image, originalFileName: 'camera.jpg' });
    await ctx.newAlbum({ ownerId: user.id, customGroupName: 'HTTP region' }, [asset.id]);
    const app = await controllerSetup(
      [AlbumCategoryController, SearchController],
      [
        { provide: AlbumCategoryService, useValue: service },
        { provide: SearchService, useValue: sut },
      ],
    );
    app.authenticate.mockResolvedValue(auth);
    const server = app.getHttpServer() as Server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test HTTP port');
    const base = `http://127.0.0.1:${address.port}`;
    /** @param path API路径。@param method HTTP方法。@param body JSON请求体。@returns 独立网络请求的响应。 */
    const send = (path: string, method: string, body: unknown) =>
      fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const create = await send('/fork/album-categories', 'POST', { name: 'HTTP travel' });
      expect(create.status).toBe(201);
      const category = (await create.json()) as { id: string };
      const assign = await send('/fork/album-categories/group', 'PUT', {
        groupName: 'HTTP region',
        categoryId: category.id,
      });
      expect(assign.status).toBe(204);
      const requests = [
        { path: '/search/smart', body: { query: 'HTTP travel', type: AssetType.Image, size: 10, page: 1 } },
        { path: '/search/metadata', body: { description: 'HTTP travel', originalFileName: 'camera', size: 10 } },
        { path: '/search/smart', body: { query: 'HTTP travel', filter: { type: { eq: AssetType.Image } }, size: 10 } },
        {
          path: '/search/metadata',
          body: { filter: { description: { like: 'HTTP travel' }, originalFileName: { like: 'camera' } }, size: 10 },
        },
      ];
      for (const { path, body } of requests) {
        const response = await send(path, 'POST', body);
        expect(response.status).toBe(200);
        const reply = (await response.json()) as { assets: { items: { id: string }[] } };
        expect(reply.assets.items.map(({ id }) => id)).toEqual([asset.id]);
      }
    } finally {
      await app.close();
    }
  });

  /** 名称/分组/大组命中互为OR，旧数据默认回退；目录操作不改变相簿时间戳或共享关系。 */
  it('unions album, group and category names and keeps the legacy default virtual', async () => {
    const { ctx, categories, service } = setup();
    const { user } = await ctx.newUser();
    const { album: byName } = await ctx.newAlbum({
      ownerId: user.id,
      albumName: 'Travel notes',
      customGroupName: 'Local',
    });
    const { album: byGroup } = await ctx.newAlbum({
      ownerId: user.id,
      albumName: 'Second',
      customGroupName: 'Travel snapshots',
    });
    const { album: byCategory } = await ctx.newAlbum({
      ownerId: user.id,
      albumName: 'Third',
      customGroupName: 'Region',
    });
    const original = await db.selectFrom('album').selectAll().where('id', '=', byCategory.id).executeTakeFirstOrThrow();
    expect(await categories.getState(user.id)).toEqual({ categories: [], groups: [] });
    const category = await service.create(user.id, 'Travel');
    await service.assign(user.id, { groupName: 'Region', categoryId: category.id });
    const repository = ctx.get(AlbumRepository);
    expect(new Set(await repository.searchIdsByText(user.id, 'Travel'))).toEqual(
      new Set([byName.id, byGroup.id, byCategory.id]),
    );
    expect(new Set(await repository.searchIdsByText(user.id, '默认'))).toEqual(new Set([byName.id, byGroup.id]));
    expect(await db.selectFrom('album').selectAll().where('id', '=', byCategory.id).executeTakeFirstOrThrow()).toEqual(
      original,
    );
    await service.delete(user.id, category.id);
    const state = await categories.getState(user.id);
    expect(state.groups).toEqual([]);
    expect(new Set(await repository.searchIdsByText(user.id, '默认'))).toEqual(
      new Set([byName.id, byGroup.id, byCategory.id]),
    );
  });

  /** 大组和映射均按当前用户隔离，私有相簿不会因同名分组或大组而外泄。 */
  it('does not cross user or album visibility boundaries', async () => {
    const { ctx, categories, service } = setup();
    const { user: first } = await ctx.newUser();
    const { user: second } = await ctx.newUser();
    const { album: allowed } = await ctx.newAlbum({ ownerId: first.id, customGroupName: 'Same region' });
    await ctx.newAlbum({ ownerId: second.id, customGroupName: 'Same region' });
    const category = await service.create(first.id, 'Only first');
    await service.assign(first.id, { groupName: 'Same region', categoryId: category.id });
    expect(await ctx.get(AlbumRepository).searchIdsByText(first.id, 'Only first')).toEqual([allowed.id]);
    expect(await ctx.get(AlbumRepository).searchIdsByText(second.id, 'Only first')).toEqual([]);
    await expect(service.assign(second.id, { groupName: 'Same region', categoryId: category.id })).rejects.toThrow(
      'Album group or category not found',
    );
    expect(await categories.getState(second.id)).toEqual({ categories: [], groups: [] });
    await expect(service.rename(second.id, category.id, 'Changed')).rejects.toThrow('Album category not found');
  });

  /** 通配符按字面匹配，名称重复返回明确冲突而不产生两个同名节点。 */
  it('escapes wildcard category names and enforces unique names', async () => {
    const { ctx, service } = setup();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id, customGroupName: 'Literal group' });
    const category = await service.create(user.id, '100%_done');
    await service.assign(user.id, { groupName: 'Literal group', categoryId: category.id });
    await service.create(user.id, '100percent');
    expect(await ctx.get(AlbumRepository).searchIdsByText(user.id, '100%_')).toEqual([album.id]);
    await expect(service.create(user.id, '100%_done')).rejects.toThrow('Album category name already exists');
    await expect(service.rename(user.id, category.id, '100percent')).rejects.toThrow(
      'Album category name already exists',
    );
    await expect(service.create(user.id, '默认')).rejects.toThrow('Default album category is virtual');
  });

  /** 手机平铺条件与Web结构化条件都必须保留类型、日期和其他文本筛选，重叠相簿内容只返回一次。 */
  it('keeps other filters and deduplicates assets across legacy and structured search', async () => {
    const { ctx, sut, service } = setup();
    const { user } = await ctx.newUser();
    const auth = AuthFactory.from({ id: user.id }).session().build();
    const eligible = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Image,
      originalFileName: 'eligible.jpg',
      fileCreatedAt: new Date('2026-06-01'),
    });
    const video = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Video,
      originalFileName: 'eligible.mp4',
      fileCreatedAt: new Date('2026-06-01'),
    });
    const older = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Image,
      originalFileName: 'eligible-old.jpg',
      fileCreatedAt: new Date('2020-06-01'),
    });
    const different = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Image,
      originalFileName: 'other.jpg',
      fileCreatedAt: new Date('2026-06-01'),
    });
    const hidden = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Image,
      originalFileName: 'eligible-hidden.jpg',
      fileCreatedAt: new Date('2026-06-01'),
      visibility: AssetVisibility.Hidden,
    });
    for (const { asset } of [eligible, video, older, different, hidden])
      await ctx.newExif({ assetId: asset.id, description: 'flower' });
    const assetIds = [eligible, video, older, different, hidden].map(({ asset }) => asset.id);
    await ctx.newAlbum({ ownerId: user.id, customGroupName: 'Region A' }, assetIds);
    await ctx.newAlbum({ ownerId: user.id, customGroupName: 'Region B' }, [eligible.asset.id]);
    const category = await service.create(user.id, 'Search category');
    for (const groupName of ['Region A', 'Region B'])
      await service.assign(user.id, { groupName, categoryId: category.id });
    const takenAfter = new Date('2025-01-01');
    const legacy = {
      size: 100,
      type: AssetType.Image,
      takenAfter,
      originalFileName: 'eligible',
      visibility: AssetVisibility.Timeline,
    };
    const structured = {
      size: 100,
      filter: {
        type: { eq: AssetType.Image },
        takenAt: { gte: takenAfter },
        originalFileName: { like: 'eligible' },
        visibility: { eq: AssetVisibility.Timeline },
      },
    };
    const requests = [
      () => sut.searchSmart(auth, { ...legacy, query: 'Search category', description: 'flower' } as SmartSearchDto),
      () =>
        sut.searchSmart(auth, {
          ...structured,
          query: 'Search category',
          filter: { ...structured.filter, description: { like: 'flower' } },
        } as SmartSearchDto),
      () => sut.searchMetadata(auth, { ...legacy, description: 'Search category' } as MetadataSearchDto),
      () =>
        sut.searchMetadata(auth, {
          ...structured,
          filter: { ...structured.filter, description: { like: 'Search category' } },
        } as MetadataSearchDto),
    ];
    for (const search of requests) {
      const response = await search();
      expect(response.assets.items.map(({ id }) => id)).toEqual([eligible.asset.id]);
    }
  });

  /** 旧搜索翻页和新元数据游标都必须稳定，不因同图在多个相簿中出现而重复。 */
  it('paginates the union without repeating assets from overlapping albums', async () => {
    const { ctx, sut, service } = setup();
    const { user } = await ctx.newUser();
    const auth = AuthFactory.from({ id: user.id }).session().build();
    const assets = await Promise.all(Array.from({ length: 5 }, () => ctx.newAsset({ ownerId: user.id })));
    const ids = assets.map(({ asset }) => asset.id);
    await ctx.newAlbum({ ownerId: user.id, customGroupName: 'First' }, ids);
    await ctx.newAlbum({ ownerId: user.id, customGroupName: 'Second' }, ids.slice(0, 3));
    const category = await service.create(user.id, 'Paged');
    await service.assign(user.id, { groupName: 'First', categoryId: category.id });
    await service.assign(user.id, { groupName: 'Second', categoryId: category.id });
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await sut.searchMetadata(auth, { size: 2, filter: { description: { like: 'Paged' } }, cursor });
      collected.push(...result.assets.items.map(({ id }) => id));
      cursor = result.assets.nextCursor ?? undefined;
    } while (cursor && collected.length < 10);
    expect(collected).toHaveLength(ids.length);
    expect(new Set(collected)).toEqual(new Set(ids));
    const first = await sut.searchMetadata(auth, { size: 2, filter: { description: { like: 'Paged' } } });
    expect(first.assets.items.map(({ id }) => id)).toEqual(collected.slice(0, 2));
    const legacy: string[] = [];
    let page = 1;
    do {
      const result = await sut.searchSmart(auth, { size: 2, query: 'Paged', page });
      legacy.push(...result.assets.items.map(({ id }) => id));
      page = Number(result.assets.nextPage) || 0;
    } while (page && legacy.length < 10);
    expect(legacy).toHaveLength(ids.length);
    expect(new Set(legacy)).toEqual(new Set(ids));
  });

  /** 新建的大组可以为空；把不存在分组写入目录或指定其他账号大组均应失败。 */
  it('allows empty categories and returns groups to default explicitly', async () => {
    const { ctx, service, categories } = setup();
    const { user } = await ctx.newUser();
    const category = await service.create(user.id, 'Empty');
    expect(await categories.getState(user.id)).toEqual({ categories: [category], groups: [] });
    await expect(service.assign(user.id, { groupName: 'Missing', categoryId: category.id })).rejects.toThrow();
    const { album } = await ctx.newAlbum({ ownerId: user.id, customGroupName: null });
    await service.assign(user.id, { groupName: '', categoryId: category.id });
    expect(await ctx.get(AlbumRepository).searchIdsByText(user.id, 'Empty')).toEqual([album.id]);
    await service.assign(user.id, { groupName: '', categoryId: null });
    expect(await categories.getState(user.id)).toEqual({ categories: [category], groups: [] });
    await expect(service.delete(user.id, newUuid())).rejects.toThrow('Album category not found');
  });
});
