import { ForkGeodataNameKind, ForkGeodataNameScope, getForkLocalizedNames } from '@immich/sdk';
import { localizedLocationManager } from './localized-location-manager.svelte';

const language = vi.hoisted(() => ({ value: 'zh-CN', read: vi.fn() }));

vi.mock('svelte/store', async (original) => ({
  ...(await original<typeof import('svelte/store')>()),
  fromStore: () => ({
    get current() {
      language.read();
      return language.value;
    },
  }),
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
    language.read.mockClear();

    const format = localizedLocationManager.formatter();
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
