import { ForkGeodataNameKind, ForkGeodataNameScope, getForkLocalizedNames } from '@immich/sdk';
import { localizedLocationManager } from './localized-location-manager.svelte';

const language = vi.hoisted(() => ({ value: 'zh-CN', read: vi.fn() }));

// 在应用的语言存储边界计数，保留真实fromStore，避免浏览器预打包绕过对Svelte内置模块的替身。
vi.mock('#lib/stores/preferences.store.ts', () => ({
  lang: {
    /** @param run 接收当前语言的订阅者。@returns 无外部资源的取消订阅函数。 */
    subscribe(run: (value: string) => void) {
      language.read();
      run(language.value);
      return () => {};
    },
  },
}));

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  getForkLocalizedNames: vi.fn(),
}));

describe('batch location formatting', () => {
  it('reads reactive language state once for an entire map batch and refreshes snapshots on changes', async () => {
    const beforeLoad = localizedLocationManager.formatter();
    vi.mocked(getForkLocalizedNames).mockResolvedValueOnce([
      {
        geonameId: 1_815_286,
        kind: ForkGeodataNameKind.City,
        scope: ForkGeodataNameScope.Global,
        name: 'Chengdu',
        country: 'China',
        state: 'Sichuan',
        localizedName: '成都',
        aliases: ['成都'],
      },
    ]);
    await localizedLocationManager.load();
    expect(getForkLocalizedNames).toHaveBeenCalledOnce();
    language.read.mockClear();

    const format = localizedLocationManager.formatter();
    expect(language.read).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 75_000; i++) {
      expect(format('city', 'Chengdu', { country: 'China', state: 'Sichuan' })).toBe('成都');
    }
    expect(language.read).toHaveBeenCalledTimes(1);
    expect(beforeLoad('city', 'Chengdu')).toBe('Chengdu');

    language.value = 'en';
    expect(localizedLocationManager.formatter()('city', 'Chengdu')).toBe('Chengdu');
    expect(format('city', 'Chengdu')).toBe('成都');
  });
});
