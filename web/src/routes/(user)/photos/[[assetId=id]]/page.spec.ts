import { Route } from '#lib/route.ts';
import { test } from '#test/unit/fixtures.ts';
import { AssetTypeEnum } from '@immich/sdk';
import { expect } from 'vitest';
import Page from './+page.svelte';
import { load } from './+page.ts';

/** render 装载真实页面；api 与 app 检查可观察的请求范围和侧栏顺序。 */
test('shows photos only with random photos second and videos third', async ({ render, settle, api, app }) => {
  await render(Page, load);
  await settle();
  expect(api.getTimeBuckets).toHaveBeenCalledWith({
    params: expect.objectContaining({ assetType: AssetTypeEnum.Image }),
  });
  const links = app.sidebar.links.elements().map((link) => link.getAttribute('href'));
  expect(links.slice(0, 3)).toEqual([Route.photos(), Route.randomPhotos(), Route.videos()]);
  // 移除顶部往年回忆后，首页不再发起对应回忆查询。
  expect(api.searchMemories).not.toHaveBeenCalled();
});
