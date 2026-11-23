import { MediaType } from '#lib/constants.ts';
import { searchManager } from '#lib/managers/search-manager.svelte.ts';
import SearchPresetModal from '#lib/modals/SearchPresetModal.svelte';
import type { SearchPreset } from '#lib/queries/search-preset.query.ts';
import { test } from '#test/unit/fixtures.ts';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

let saved: SearchPreset[];
/** Fork隐藏接口由独立HTTP桩保存；其余API仍由共享夹具校验，模拟重新打开时从账号读取。 */
beforeEach(() => {
  searchManager.reset();
  saved = [];
  const original = fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/fork/search-presets')) return original(input, init);
    if (request.method === 'GET') return Response.json(saved);
    if (request.method === 'POST') {
      const body = await request.json();
      saved.push({ id: crypto.randomUUID(), name: body.name, conditions: body.conditions });
      return Response.json(saved.at(-1), { status: 201 });
    }
    throw new Error('Unexpected preset operation');
  });
});
/** 关闭弹框的焦点锁，恢复原有HTTP桩，避免污染后续页面测试。 */
afterEach(async () => {
  await userEvent.keyboard('{Escape}');
  vi.restoreAllMocks();
  searchManager.reset();
});

/** 登记只包含勾选的两项，复用后覆盖它们，同时保留当前城市与文字。 */
test('registers only selected atoms and reuses them without clearing other conditions', async ({ settle }) => {
  searchManager.filter.mediaType = MediaType.Video;
  searchManager.filter.location.country = 'Japan';
  searchManager.addExifCondition({ field: 'iso', operator: 'gte', value: 800 });
  const onClose = vi.fn();
  const onApply = vi.fn();
  await render(SearchPresetModal, { onClose, onApply });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Low light');
  await dialog.getByRole('checkbox', { name: 'country · Japan', exact: true }).click();
  await dialog.getByRole('button', { name: 'save', exact: true }).click();
  await settle();
  expect(saved).toHaveLength(1);
  expect(saved[0].conditions).toEqual({
    mediaType: 'video',
    exifConditions: [{ field: 'iso', operator: 'gte', value: 800 }],
  });
  searchManager.reset();
  searchManager.filter.location.country = 'France';
  searchManager.filter.query = 'flowers';
  searchManager.filter.mediaType = MediaType.Image;
  await dialog
    .getByRole('region', { name: 'search_presets_custom' })
    .getByRole('button', { name: 'search_preset_apply' })
    .click();
  expect(searchManager.filter.mediaType).toBe(MediaType.Video);
  expect(searchManager.filter.location.country).toBe('France');
  expect(searchManager.filter.query).toBe('flowers');
  expect(searchManager.filter.exifConditions).toEqual([{ field: 'iso', operator: 'gte', value: 800 }]);
  expect(onClose).toHaveBeenCalledOnce();
  expect(onApply).toHaveBeenCalledOnce();
});

/** 内置项只改变其定义字段；它们不可编辑/删除，原有精确识别规则继续使用。 */
test('offers read-only built-in registrations and preserves unrelated criteria', async () => {
  searchManager.filter.query = 'trip';
  searchManager.filter.display.isFavorite = true;
  const onClose = vi.fn();
  await render(SearchPresetModal, { onClose, onApply: vi.fn() });
  const builtin = page.getByRole('region', { name: 'search_presets_builtin' });
  expect(builtin.getByRole('button').elements()).toHaveLength(6);
  await builtin.getByRole('button', { name: 'search_preset_apply' }).nth(3).click();
  expect(searchManager.filter.mediaCategory).toBe('steam-screenshot');
  expect(searchManager.filter.mediaType).toBe(MediaType.Image);
  expect(searchManager.filter.query).toBe('trip');
  expect(searchManager.filter.display.isFavorite).toBe(true);
  expect(builtin.getByRole('button', { name: 'delete', exact: true }).elements()).toHaveLength(0);
});
