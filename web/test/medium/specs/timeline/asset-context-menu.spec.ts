import { Route } from '#lib/route.ts';
import { factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { AlbumUserRole } from '@immich/sdk';

/** 使用受控资产和现有API夹具；不让独立场景分组或地名服务参与单张菜单验证。 */
test.beforeEach(async ({ page, api }) => {
  api.on({ getForkLocalizedNames: () => ({ json: [] }) });
  await page.addInitScript(() => {
    if (location.protocol.startsWith('http')) localStorage.setItem('immich.scene-stacks', 'false');
  });
});

/** 首页右键长按也不能勾选照片；收藏请求只包含右键命中的一张。 */
test('right clicking a photo favorites only that asset without selecting it', async ({ page, data, api, app }) => {
  const first = factory.asset({ ownerId: data.user.id });
  const second = factory.asset({ ownerId: data.user.id });
  data.addAssets([first, second]);
  await page.goto(Route.photos());
  await app.timeline.thumbnail(first).click({ button: 'right', delay: 450 });
  await expect(
    page
      .getByRole('menu', { name: 'actions', exact: true })
      .getByRole('menuitem', { name: 'set_as_album_cover', exact: true }),
  ).toHaveCount(0);
  await expect(app.timeline.thumbnail(first)).not.toHaveAttribute('data-selected');
  await page
    .getByRole('menu', { name: 'actions', exact: true })
    .getByRole('menuitem', { name: 'to_favorite', exact: true })
    .click();
  expect(api.updateAsset).toHaveBeenCalledWith({ params: { id: first.id }, body: { isFavorite: true } });
  await expect(app.timeline.thumbnail(second)).not.toHaveAttribute('data-selected');
});

/** 已勾选其他照片时，设置封面仍只写右键照片，原有勾选保持。 */
test('album cover targets the clicked photo while retaining another selection', async ({ page, data, api, app }) => {
  const first = factory.asset({ ownerId: data.user.id });
  const second = factory.asset({ ownerId: data.user.id });
  const album = factory.album({ albumUsers: [{ role: AlbumUserRole.Owner, user: data.user }] });
  data.addAssets([first, second]).addAlbums(album).addToAlbum(album.id, [first, second]);
  await page.goto(Route.viewAlbum(album));
  await app.timeline.thumbnail(second).hover();
  await app.timeline.thumbnail(second).getByRole('checkbox').click();
  await app.timeline.thumbnail(first).click({ button: 'right', timeout: 5000 });
  await expect.poll(() => api.getAssetInfo.calls.length).toBe(1);
  await page
    .getByRole('menu', { name: 'actions', exact: true })
    .getByRole('menuitem', { name: 'set_as_album_cover', exact: true })
    .click({ timeout: 5000 });
  expect(api.updateAlbumInfo).toHaveBeenCalledWith({
    params: { id: album.id },
    body: { albumThumbnailAssetId: first.id },
  });
  await expect(app.timeline.thumbnail(second)).toHaveAttribute('data-selected', 'true');
  await expect(app.timeline.thumbnail(first)).not.toHaveAttribute('data-selected');
});

/** 相簿编辑者能用成员照片设封面，但不能修改他人的收藏或标签。 */
test('album editors can set a cover without asset ownership actions', async ({ page, data, api, app }) => {
  const owner = factory.user();
  const asset = factory.asset({ ownerId: owner.id });
  const album = factory.album({
    shared: true,
    albumUsers: [
      { role: AlbumUserRole.Owner, user: owner },
      { role: AlbumUserRole.Editor, user: data.user },
    ],
  });
  data.addAssets(asset).addAlbums(album).addToAlbum(album.id, [asset]);
  await page.goto(Route.viewAlbum(album));
  await app.timeline.thumbnail(asset).click({ button: 'right' });
  await expect(
    page
      .getByRole('menu', { name: 'actions', exact: true })
      .getByRole('menuitem', { name: 'to_favorite', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('menu', { name: 'actions', exact: true }).getByRole('menuitem', { name: 'add_tag', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('menu', { name: 'actions', exact: true })
    .getByRole('menuitem', { name: 'set_as_album_cover', exact: true })
    .click();
  expect(api.updateAlbumInfo).toHaveBeenCalledWith({
    params: { id: album.id },
    body: { albumThumbnailAssetId: asset.id },
  });
});

/** 只读成员仍可查看/下载；不能从菜单修改封面或移除他人的照片。 */
test('album viewers do not see edit actions', async ({ page, data, api, app }) => {
  const owner = factory.user();
  const asset = factory.asset({ ownerId: owner.id });
  const album = factory.album({
    shared: true,
    albumUsers: [
      { role: AlbumUserRole.Owner, user: owner },
      { role: AlbumUserRole.Viewer, user: data.user },
    ],
  });
  data.addAssets(asset).addAlbums(album).addToAlbum(album.id, [asset]);
  await page.goto(Route.viewAlbum(album));
  await app.timeline.thumbnail(asset).click({ button: 'right' });
  await expect(
    page.getByRole('menu', { name: 'actions', exact: true }).getByRole('menuitem', { name: 'download', exact: true }),
  ).toBeVisible();
  for (const name of ['set_as_album_cover', 'to_favorite', 'add_tag', 'remove_from_album']) {
    await expect(
      page.getByRole('menu', { name: 'actions', exact: true }).getByRole('menuitem', { name, exact: true }),
    ).toHaveCount(0);
  }
  await page.keyboard.press('Escape');
  expect(api.updateAlbumInfo.calls).toHaveLength(0);
});

/** 资产读取较慢时按Escape取消，响应回来也不能重新打开菜单。 */
test('escape cancels a pending context menu', async ({ page, data, api, app }) => {
  const asset = factory.asset({ ownerId: data.user.id });
  data.addAssets(asset);
  let complete = () => {};
  const waiting = new Promise<void>((resolve) => {
    complete = resolve;
  });
  api.on({
    getAssetInfo: async () => {
      await waiting;
      return { json: asset };
    },
  });
  await page.goto(Route.photos());
  await app.timeline.thumbnail(asset).click({ button: 'right' });
  await expect.poll(() => api.getAssetInfo.calls.length).toBe(1);
  await page.keyboard.press('Escape');
  const loaded = page.waitForResponse((response) => response.url().endsWith('/assets/' + asset.id));
  complete();
  const response = await loaded;
  await response.finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByRole('menu', { name: 'actions', exact: true })).toHaveCount(0);
  await expect(app.timeline.thumbnail(asset)).not.toHaveAttribute('data-selected');
});

/** 同屏连续右键两张时，旧响应不得覆盖新目标；验证菜单最终写入第二张。 */
test('a late response cannot replace the latest right clicked asset', async ({ page, data, api, app }) => {
  const first = factory.asset({ ownerId: data.user.id });
  const second = factory.asset({ ownerId: data.user.id });
  data.addAssets([first, second]);
  let complete = () => {};
  const waiting = new Promise<void>((resolve) => {
    complete = resolve;
  });
  api.on({
    getAssetInfo: async ({ params }) => {
      if (params.id === first.id) {
        await waiting;
        return { json: first };
      }
      return { json: second };
    },
  });
  await page.goto(Route.photos());
  await app.timeline.thumbnail(first).click({ button: 'right' });
  await expect.poll(() => api.getAssetInfo.calls.length).toBe(1);
  await app.timeline.thumbnail(second).click({ button: 'right' });
  await expect(
    page
      .getByRole('menu', { name: 'actions', exact: true })
      .getByRole('menuitem', { name: 'to_favorite', exact: true }),
  ).toBeVisible();
  complete();
  await page
    .getByRole('menu', { name: 'actions', exact: true })
    .getByRole('menuitem', { name: 'to_favorite', exact: true })
    .click();
  expect(api.updateAsset).toHaveBeenCalledWith({ params: { id: second.id }, body: { isFavorite: true } });
});
