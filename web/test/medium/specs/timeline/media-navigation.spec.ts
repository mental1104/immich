import { Route } from '#lib/route.ts';
import { factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { AssetTypeEnum } from '@immich/sdk';

/** api 仅拦截隔离浏览器请求；地名不是本次导航验收的数据依赖。 */
test.beforeEach(({ api }) => {
  api.on({ getForkLocalizedNames: () => ({ json: [] }) });
});

/** 混合照片和视频输入，经过真实路由切换与刷新后仍保持各自的查询范围。 */
test('photos and videos remain separate across navigation and reload', async ({ page, data, api, app }) => {
  const image = factory.asset({ type: AssetTypeEnum.Image });
  const video = factory.asset({ type: AssetTypeEnum.Video });
  data.addAssets([image, video]);
  await page.goto(Route.photos());
  await expect(app.timeline.thumbnail(image)).toBeVisible();
  await expect(app.timeline.thumbnail(video)).toHaveCount(0);
  await expect(app.memories.card()).toHaveCount(0);
  await page.getByRole('link', { name: 'videos', exact: true }).click();
  await expect(app.timeline.thumbnail(video)).toBeVisible();
  await expect(app.timeline.thumbnail(image)).toHaveCount(0);
  await page.reload();
  await expect(app.timeline.thumbnail(video)).toBeVisible();
  expect(api.getTimeBuckets).toHaveBeenCalledWith({
    params: expect.objectContaining({ assetType: AssetTypeEnum.Video }),
  });
});

/** 随机照片查看器使用本批前后导航；关闭和刷新保留可用入口，换批才替换照片。 */
test('random gallery keeps its batch through viewer navigation and supports shuffling', async ({
  page,
  data,
  api,
  app,
}) => {
  const first = factory.asset();
  const second = factory.asset();
  const replacement = factory.asset();
  data.addAssets([first, second, replacement]);
  let batch = [first, second];
  api.on({ searchRandom: () => ({ json: batch }) });
  await page.goto(Route.randomPhotos());
  /** id 为本批照片 UUID；返回可点击缩略图定位器。 */
  const thumbnail = (id: string) => page.locator(`[data-thumbnail-focus-container][data-asset="${id}"]`);
  await thumbnail(first.id).click();
  await app.viewer.waitForAsset(first);
  await app.viewer.nextButton.click();
  await app.viewer.waitForAsset(second);
  await app.viewer.backButton.click();
  await expect(thumbnail(second.id)).toBeVisible();
  expect(api.searchRandom.calls).toHaveLength(1);
  batch = [replacement];
  await page.getByRole('button', { name: 'shuffle_photos' }).click();
  await expect(thumbnail(replacement.id)).toBeVisible();
  await expect(thumbnail(first.id)).toHaveCount(0);
  await page.reload();
  await expect(thumbnail(replacement.id)).toBeVisible();
  expect(api.searchRandom).toHaveBeenCalledWith({ body: expect.objectContaining({ type: AssetTypeEnum.Image }) });
});
