import { AssetTypeEnum } from '@immich/sdk';
import { goto } from '$app/navigation';
import { MediaType } from '$lib/constants';
import { searchManager } from '$lib/managers/search-manager.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

describe('SearchManager', () => {
  beforeEach(() => {
    localStorage.clear();
    searchManager.reset();
    vi.mocked(goto).mockClear();
  });

  it('defaults to smart search', () => {
    expect(searchManager.filter.queryType).toBe('smart');
  });

  it('remembers the selected query type', () => {
    searchManager.setQueryType('metadata');
    expect(searchManager.filter.queryType).toBe('metadata');

    searchManager.reset();
    expect(searchManager.filter.queryType).toBe('metadata');
  });

  it('overrides a previously stored query type', () => {
    localStorage.setItem('searchQueryType', 'metadata');
    searchManager.reset();

    searchManager.setQueryType('smart');
    searchManager.reset();
    expect(searchManager.filter.queryType).toBe('smart');
  });

  it('ignores an invalid stored query type', () => {
    localStorage.setItem('searchQueryType', 'invalid');
    searchManager.reset();
    expect(searchManager.filter.queryType).toBe('smart');
  });

  /** 通过 URL 恢复全景条件，清空筛选时关闭，避免误影响后续普通搜索。 */
  it('restores and clears the panorama filter', () => {
    expect(searchManager.filter.isPanorama).toBe(false);
    searchManager.setQuery({ isPanorama: true });
    expect(searchManager.filter.isPanorama).toBe(true);
    searchManager.reset();
    expect(searchManager.filter.isPanorama).toBe(false);
  });

  it('restores category shortcuts and clears them when filters reset', () => {
    searchManager.setQuery({ isPhoneVideo: true, type: AssetTypeEnum.Video });
    expect(searchManager.filter.mediaCategory).toBe('phone-video');
    expect(searchManager.filter.mediaType).toBe(MediaType.Video);
    searchManager.setQuery({ isScreenshot: true, type: AssetTypeEnum.Image });
    expect(searchManager.filter.mediaCategory).toBe('screenshot');
    expect(searchManager.filter.mediaType).toBe(MediaType.Image);
    searchManager.reset();
    expect(searchManager.filter.mediaCategory).toBeUndefined();
  });

  it.each(['phone-video', 'screenshot'] as const)('submits %s with its matching search flag', async (category) => {
    searchManager.filter.mediaCategory = category;
    await searchManager.submit();
    const target = String(vi.mocked(goto).mock.calls[0][0]);
    const query = JSON.parse(new URL(target, 'https://test.invalid').searchParams.get('query')!);
    expect(query.isPhoneVideo).toBe(category === 'phone-video' ? true : undefined);
    expect(query.isScreenshot).toBe(category === 'screenshot' ? true : undefined);
  });

  it('combines exposure and camera filters in the structured search filter', async () => {
    searchManager.filter.camera.make = 'Canon';
    searchManager.filter.camera.lensModel = 'RF 85mm F1.2 L USM';
    searchManager.addExifCondition({ field: 'fNumber', operator: 'lte', value: 2.8 });
    await searchManager.submit();

    const target = String(vi.mocked(goto).mock.calls[0][0]);
    const query = JSON.parse(new URL(target, 'https://test.invalid').searchParams.get('query')!);

    expect(query.filter).toMatchObject({
      fNumber: { lte: 2.8 },
      make: { eq: 'Canon' },
      lensModel: { eq: 'RF 85mm F1.2 L USM' },
    });
    expect(query.make).toBeUndefined();
    expect(query.lensModel).toBeUndefined();
  });
});
