import SearchBarHost from '#lib/components/shared-components/search-bar/SearchBarTestHost.svelte';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { searchManager } from '#lib/managers/search-manager.svelte.ts';
import { test } from '#test/unit/fixtures.ts';
import { expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

/** 从实际入口打开登记弹框，确认组合项已移出原子菜单，登记按钮排在搜索按钮左边。 */
test('opens registrations from the button immediately before search', async () => {
  await authManager.load();
  searchManager.reset();
  const original = fetch;
  const stub = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    return new URL(request.url).pathname === '/api/fork/search-presets'
      ? Promise.resolve(Response.json([]))
      : original(input, init);
  });
  try {
    await page.viewport(1280, 800);
    await render(SearchBarHost);
    const register = page.getByRole('button', { name: 'search_preset_register', exact: true });
    const search = page.getByRole('button', { name: 'search', exact: true });
    await expect.element(register).toBeVisible();
    expect(register.element().getBoundingClientRect().x).toBeLessThan(search.element().getBoundingClientRect().x);
    await register.click();
    await expect.element(page.getByRole('dialog')).toBeVisible();
    await expect.element(page.getByRole('region', { name: 'search_presets_builtin' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'media_categories', exact: true })).not.toBeInTheDocument();
  } finally {
    stub.mockRestore();
    searchManager.reset();
  }
});
