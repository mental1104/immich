import { Route } from '#lib/route.ts';
import { test } from '#test/unit/fixtures.ts';
import { AssetTypeEnum, AssetVisibility } from '@immich/sdk';
import { expect } from 'vitest';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import { load } from './+page.ts';

/** 空图库不挂起或误跳到照片页；换一批仍必须使用照片和可见范围。 */
test('supports an empty random gallery and shuffling again', async ({ router, render, settle, api }) => {
  api.on({ searchRandom: () => ({ json: [] }) });
  await router.goto(Route.randomPhotos());
  await render(Page, load);
  await settle();
  await expect.element(page.getByText('no_assets_message')).toBeVisible();
  const initialCalls = api.searchRandom.calls.length;
  await page.getByRole('button', { name: 'shuffle_photos' }).click();
  await settle();
  expect(api.searchRandom.calls.length).toBe(initialCalls + 1);
  expect(api.searchRandom).toHaveBeenCalledWith({
    body: {
      type: AssetTypeEnum.Image,
      visibility: AssetVisibility.Timeline,
      size: 60,
      withDeleted: false,
    },
  });
  expect(router.url.pathname).toBe(Route.randomPhotos());
});
