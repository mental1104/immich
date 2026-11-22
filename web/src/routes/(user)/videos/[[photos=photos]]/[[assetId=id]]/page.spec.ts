import { Route } from '#lib/route.ts';
import { test } from '#test/unit/fixtures.ts';
import { AssetTypeEnum } from '@immich/sdk';
import { expect } from 'vitest';
import Page from './+page.svelte';
import { load } from './+page.ts';

/** 视频页使用独立服务端筛选；照片默认值不能覆盖此入口。 */
test('requests a video-only timeline', async ({ router, render, settle, api }) => {
  await router.goto(Route.videos());
  await render(Page, load);
  await settle();
  expect(api.getTimeBuckets).toHaveBeenCalledWith({
    params: expect.objectContaining({ assetType: AssetTypeEnum.Video }),
  });
});
