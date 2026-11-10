import { expect, test } from '@playwright/test';
import { createDefaultTimelineConfig, generateTimelineData } from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupTimelineMockApiRoutes, TimelineTestContext } from 'src/ui/mock-network/timeline-network.js';

/** 浏览器验收使用完整 Immich 照片查看器及合成 API；真实模型另由显式 live 测试验证。 */
test('Photo Copilot opens in the native viewer, changes assets and reconnects after refresh', async ({
  page,
  context,
}) => {
  const owner = '00000000-0000-4000-8000-000000000001';
  const data = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: owner });
  const allAssets = data.buckets.values().toArray().flat();
  const firstImage = allAssets.findIndex((asset, index) => asset.isImage && allAssets[index + 1]?.isImage);
  const assets = allAssets.slice(firstImage, firstImage + 2);
  const testContext = new TimelineTestContext();
  testContext.adminId = owner;
  await setupBaseMockApiRoutes(context, owner);
  await setupTimelineMockApiRoutes(
    context,
    data,
    { albumAdditions: [], assetDeletions: [], assetArchivals: [], assetFavorites: [] },
    testContext,
  );
  const messages = new Map<string, { id: string; role: string; text: string }[]>();
  let restored = false;
  let unavailable = false;
  await context.route('**/api/fork/photo-copilot/**', async (route) => {
    const url = new URL(route.request().url());
    const assetId = url.pathname.split('/', 6)[5];
    const history = messages.get(assetId) || [];
    const state = {
      id: assetId,
      assetId,
      fileName: 'synthetic.jpg',
      context: { assetId },
      image: 'original',
      status: 'completed',
      busy: false,
      error: null,
      messages: history,
    };
    if (unavailable) {
      return route.fulfill({ status: 503, json: { message: 'Photo Copilot is disabled' } });
    }
    if (url.pathname.endsWith('/events')) {
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(state)}\n\n` });
    }
    const body = route.request().postDataJSON();
    if (body.sessionId) {
      restored = true;
    }
    if (body.message) {
      history.push(
        { id: `user-${history.length}`, role: 'user', text: body.message },
        { id: `assistant-${history.length}`, role: 'assistant', text: 'Synthetic photo response' },
      );
      messages.set(assetId, history);
    }
    return route.fulfill({ json: state });
  });
  await page.goto(`/photos/${assets[0].id}`);
  await page.getByRole('button', { name: 'Photo Copilot', exact: true }).click();
  const panel = page.getByTestId('photo-copilot-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('copilot-asset-id')).toHaveText(assets[0].id);
  await page.getByLabel('Message about this photo').fill('Describe this photo');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByText('Synthetic photo response')).toBeVisible();
  await panel.getByLabel('Close Photo Copilot').click();
  await expect(panel).not.toBeVisible();
  await page.getByRole('button', { name: 'Photo Copilot', exact: true }).click();
  await expect(panel.getByText('Synthetic photo response')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Photo Copilot', exact: true }).click();
  await expect(panel.getByText('Synthetic photo response')).toBeVisible();
  expect(restored).toBe(true);
  // 同一 SvelteKit 查看器内切换照片，不重新加载整个浏览器页面。
  await page.getByLabel('View next asset', { exact: true }).click();
  await expect(page.getByTestId('copilot-asset-id')).toHaveText(assets[1].id);
  await expect(panel.getByText('Synthetic photo response')).not.toBeVisible();
  await panel.getByLabel('Close Photo Copilot').click();
  unavailable = true;
  await page.getByRole('button', { name: 'Photo Copilot', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('Photo Copilot is disabled');
});
