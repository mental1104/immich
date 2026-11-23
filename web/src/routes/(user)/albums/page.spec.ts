import type { AlbumCategoryState } from '#lib/queries/album-category.query.ts';
import { Route } from '#lib/route.ts';
import { AlbumGroupBy, AlbumViewMode, albumViewSettings } from '#lib/stores/preferences.store.ts';
import { sidebarStore } from '#lib/stores/sidebar.svelte.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { get } from 'svelte/store';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import Page from './+page.svelte';
import { load } from './+page.ts';

let directory: AlbumCategoryState;
let commands: { method: string; body: unknown }[];

/** Fork隐藏接口不在官方OpenAPI夹具内，单独拦截其HTTP请求；其余接口继续由现有api夹具验证。 */
beforeEach(() => {
  directory = { categories: [], groups: [] };
  commands = [];
  albumViewSettings.update((settings) => ({
    ...settings,
    coversOnly: false,
    groupBy: AlbumGroupBy.Year,
    view: AlbumViewMode.Cover,
    collapsedGroups: {},
  }));
  const original = fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/fork/album-categories')) return original(input, init);
    if (request.method === 'GET') return Response.json(directory);
    const body = await request.json();
    commands.push({ method: request.method, body });
    if (request.method === 'POST') {
      directory.categories.push({ id: crypto.randomUUID(), name: body.name });
    } else if (request.method === 'PUT') {
      directory.groups = directory.groups.filter((group) => group.groupName !== body.groupName);
      if (body.categoryId) directory.groups.push({ groupName: body.groupName, categoryId: body.categoryId });
    }
    return Response.json({}, { status: 200 });
  });
});

/** 恢复当前测试原有HTTP夹具，避免把目录桩带入其他页面。 */
afterEach(async () => {
  await userEvent.keyboard('{Escape}');
  vi.restoreAllMocks();
});

/** 旧的分组/收起偏好不能隐藏新版结果；封面和列表都只由左栏限定范围，不改写旧偏好。 */
for (const [groupBy, view] of [
  [AlbumGroupBy.Custom, AlbumViewMode.Cover],
  [AlbumGroupBy.Year, AlbumViewMode.Cover],
  [AlbumGroupBy.Custom, AlbumViewMode.List],
  [AlbumGroupBy.Year, AlbumViewMode.List],
] as const) {
  test(`keeps flat results for saved ${groupBy} grouping in ${view} view`, async ({ data, render, settle, app }) => {
    albumViewSettings.update((settings) => ({
      ...settings,
      groupBy,
      view,
      collapsedGroups: { [AlbumGroupBy.Custom]: ['custom:North'], [AlbumGroupBy.Year]: ['2024'] },
    }));
    data.addAlbums(factory.album({ albumName: 'Flat A', customGroupName: 'North', endDate: '2024-02-01' }));
    data.addAlbums(factory.album({ albumName: 'Flat B', customGroupName: 'South', endDate: '2024-03-01' }));
    await render(Page, load);
    await settle();
    if (view === AlbumViewMode.Cover) {
      await expect.element(app.albums.card('Flat A')).toBeVisible();
      await expect.element(app.albums.card('Flat B')).toBeVisible();
    } else {
      await expect.element(page.getByRole('cell', { name: 'Flat A', exact: true })).toBeVisible();
      await expect.element(page.getByRole('cell', { name: 'Flat B', exact: true })).toBeVisible();
    }
    // 同一分组名只剩左栏入口，不再出现右侧可折叠的同名标题。
    expect(page.getByRole('button', { name: /North/ }).elements()).toHaveLength(1);
    await expect.element(page.getByTitle('group_albums_by')).not.toBeInTheDocument();
    await expect.element(page.getByTitle('expand_all')).not.toBeInTheDocument();
    await expect.element(page.getByTitle('collapse_all')).not.toBeInTheDocument();
    expect(get(albumViewSettings).groupBy).toBe(groupBy);
    expect(get(albumViewSettings).collapsedGroups?.[AlbumGroupBy.Custom]).toEqual(['custom:North']);
  });
}

/** 顶部管理栏和左侧分组同时可用；切换大组会重置分组，过滤后的全选不跨组。 */
test('navigates groups inside categories with a visible management toolbar', async ({ data, render, settle, app }) => {
  directory = {
    categories: [{ id: 'travel', name: 'Travel' }],
    groups: [{ groupName: 'Region', categoryId: 'travel' }],
  };
  data.addAlbums(factory.album({ albumName: 'Mountains', customGroupName: 'Region' }));
  data.addAlbums(factory.album({ albumName: 'Game', customGroupName: 'Games' }));
  data.addAlbums(factory.album({ albumName: 'Other', customGroupName: '' }));
  await render(Page, load);
  await settle();
  const toolbar = page.getByRole('group', { name: 'album_management_toolbar' });
  await expect.element(toolbar.getByPlaceholder('search_albums_and_groups')).toBeVisible();
  await expect.element(toolbar.getByRole('button', { name: 'create_album', exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'album_group_navigation' });
  await navigation.getByRole('button', { name: /Games\s*1/ }).click();
  await expect.element(app.albums.card('Game')).toBeVisible();
  await expect.element(app.albums.card('Mountains')).not.toBeInTheDocument();
  await toolbar.getByRole('button', { name: 'select_albums', exact: true }).click();
  await toolbar.getByRole('button', { name: 'select_all_filtered_albums', exact: true }).click();
  await expect.element(page.getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'Travel', exact: true }).click();
  await expect
    .element(navigation.getByRole('button', { name: /album_all_groups\s*1/ }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect.element(app.albums.card('Mountains')).toBeVisible();
  await expect.element(app.albums.card('Game')).not.toBeInTheDocument();
  await expect.element(page.getByRole('checkbox')).not.toBeChecked();
});

/** 切换大组只限定当前列表，“全部”始终跨大组；名称搜索含大组词且不需要Enter。 */
test('filters albums by optional category and searches category names immediately', async ({
  data,
  render,
  settle,
  app,
}) => {
  directory = {
    categories: [{ id: 'travel', name: 'Travel' }],
    groups: [{ groupName: 'Region', categoryId: 'travel' }],
  };
  data.addAlbums(factory.album({ albumName: 'Mountains', customGroupName: 'Region' }));
  data.addAlbums(factory.album({ albumName: 'Game', customGroupName: 'Games' }));
  await render(Page, load);
  await settle();
  await page.getByRole('button', { name: 'Travel', exact: true }).click();
  await expect.element(app.albums.card('Mountains')).toBeVisible();
  await expect.element(app.albums.card('Game')).not.toBeInTheDocument();
  await page.getByRole('button', { name: 'album_category_default', exact: true }).click();
  await expect.element(app.albums.card('Game')).toBeVisible();
  await expect.element(app.albums.card('Mountains')).not.toBeInTheDocument();
  await page.getByRole('button', { name: 'all_albums', exact: true }).click();
  await expect.element(app.albums.card('Mountains')).toBeVisible();
  await expect.element(app.albums.card('Game')).toBeVisible();
  await page.getByPlaceholder('search_albums_and_groups').first().fill('Travel');
  await expect.element(app.albums.card('Game')).not.toBeInTheDocument();
  await expect.element(app.albums.card('Mountains')).toBeVisible();
});

/** 全选范围由当前大组与搜索结果共同限定，切回全部后其他分组不能被误选。 */
test('selects only albums in the currently filtered category', async ({ data, render, settle }) => {
  directory = {
    categories: [{ id: 'travel', name: 'Travel' }],
    groups: [{ groupName: 'Region', categoryId: 'travel' }],
  };
  data.addAlbums(factory.album({ albumName: 'Trip', customGroupName: 'Region' }));
  data.addAlbums(factory.album({ albumName: 'Game', customGroupName: 'Games' }));
  await render(Page, load);
  await settle();
  await page.getByRole('button', { name: 'Travel', exact: true }).click();
  await page.getByRole('button', { name: 'select_albums', exact: true }).click();
  await page.getByRole('button', { name: 'select_all_filtered_albums', exact: true }).click();
  await expect.element(page.getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'all_albums', exact: true }).click();
  const checkboxes = page.getByRole('checkbox').elements();
  expect(checkboxes).toHaveLength(2);
  expect(checkboxes.filter((element) => element.getAttribute('aria-checked') === 'true')).toHaveLength(1);
});

/** 纯封面不显示数量和日期；键盘仍能识别相簿，详情随时可恢复。 */
test('toggles cover details and retains accessible album links', async ({ data, render, app }) => {
  data.addAlbums(factory.album({ albumName: 'Cover album', assetCount: 12 }));
  await render(Page, load);
  await page.getByRole('button', { name: 'album_covers_only', exact: true }).click();
  await expect.element(app.albums.card('Cover album').getByTestId('album-details')).not.toBeInTheDocument();
  await expect.element(page.getByRole('link', { name: 'Cover album', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'album_show_details', exact: true }).click();
  await expect.element(app.albums.card('Cover album').getByTestId('album-details')).toBeVisible();
});

/** 用户从实际模态框创建大组，再把原分组整体移动进去，不逐相簿改写。 */
test('creates a category and assigns an existing group through the UI', async ({ data, render, settle }) => {
  data.addAlbums(factory.album({ albumName: 'Trip', customGroupName: 'Region' }));
  await render(Page, load);
  await settle();
  await page.getByRole('button', { name: 'album_categories_manage', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Travel');
  await dialog.getByRole('button', { name: 'save', exact: true }).click();
  await settle();
  const category = directory.categories[0];
  await dialog.getByRole('combobox').selectOptions(category.id);
  await settle();
  expect(commands).toEqual([
    { method: 'POST', body: { method: 'POST', name: 'Travel' } },
    { method: 'PUT', body: { method: 'PUT', groupName: 'Region', categoryId: category.id } },
  ]);
});

test('lists the albums with their sharing state', async ({ data, render, app }) => {
  data.addAlbums(factory.album({ albumName: 'Holiday', shared: false }));
  data.addAlbums(factory.album({ albumName: 'Team', shared: true }));

  await render(Page, load);

  await expect.element(app.albums.card('Holiday').getByText('shared', { exact: true })).not.toBeInTheDocument();
  await expect.element(app.albums.card('Team').getByText('shared', { exact: true })).toBeVisible();
});

test('shows a cover image for an album without a thumbnail', async ({ data, render, app }) => {
  data.addAlbums(factory.album({ albumName: 'Empty', albumThumbnailAssetId: null }));

  await render(Page, load);

  await expect.element(app.albums.card('Empty').getByAltText('Empty')).toBeVisible();
});

test('sidebar lists the three most recently updated albums', async ({ data, render, settle, app }) => {
  const albums = [
    factory.album({ albumName: 'Oldest', updatedAt: '2024-01-01T00:00:00Z' }),
    factory.album({ albumName: 'Second', updatedAt: '2024-01-09T00:00:01Z' }),
    factory.album({ albumName: 'Newest', updatedAt: '2024-01-10T00:00:00Z' }),
    factory.album({ albumName: 'Third', updatedAt: '2024-01-09T00:00:00Z' }),
  ];
  data.addAlbums(albums);

  await render(Page, load);
  await settle();

  const albumLinks = app.sidebar.links.elements().map((link) => link.getAttribute('href')!);
  expect(albumLinks.filter((href) => href.startsWith('/albums/'))).toEqual([
    Route.viewAlbum(albums[2]),
    Route.viewAlbum(albums[1]),
    Route.viewAlbum(albums[3]),
  ]);
});

test('creating an album navigates to it', async ({ router, render, settle, api, app }) => {
  await router.goto(Route.albums());
  await render(Page, load);

  await app.albums.createAlbumButton.click();
  await settle();

  expect(api.createAlbum).toHaveBeenCalled();
  expect(router.url.pathname).toMatch(/^\/albums\/[0-9a-f-]+$/);
});

test('sidebar is closed and inert on a narrow screen', async ({ render, app }) => {
  await page.viewport(500, 800);

  await render(Page, load);

  expect(app.sidebar.root.element()).toHaveProperty('inert', true);
  await page.viewport(1280, 720);
});

test('sidebar left open closes again when a narrow page renders', async ({ render }) => {
  await page.viewport(500, 800);
  sidebarStore.isOpen = true;

  await render(Page, load);

  expect(sidebarStore.isOpen).toBe(false);
  await page.viewport(1280, 720);
});
