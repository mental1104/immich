import { MediaType } from '#lib/constants.ts';
import { searchManager } from '#lib/managers/search-manager.svelte.ts';
import { AssetTypeEnum } from '@immich/sdk';
import { goto } from '$app/navigation';

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

  /** 添加多个编辑条件时分别生成原子项，移除一个不会顺带清空相机或另一端EXIF范围。 */
  it('keeps added conditions atomic and removes one criterion independently', () => {
    searchManager.filter.camera.make = 'Canon';
    searchManager.filter.mediaType = MediaType.Image;
    searchManager.addExifCondition({ field: 'iso', operator: 'gte', value: 800 });
    searchManager.addExifCondition({ field: 'iso', operator: 'lte', value: 3200 });
    searchManager.addCurrentCondition('Combined label');
    expect(searchManager.conditionAtoms.map(({ id }) => id)).toEqual([
      'make',
      'mediaType',
      'exif:iso:gte',
      'exif:iso:lte',
    ]);
    searchManager.removeConditionAtom('exif:iso:gte');
    expect(searchManager.effectiveFilter.camera.make).toBe('Canon');
    expect(searchManager.effectiveFilter.mediaType).toBe(MediaType.Image);
    expect(searchManager.effectiveFilter.exifConditions).toEqual([{ field: 'iso', operator: 'lte', value: 3200 }]);
  });

  /** 登记只覆盖所含字段；设备、方向与EXIF一起提交和刷新时都能准确还原。 */
  it('reuses selected criteria and restores the structured request after refresh', async () => {
    searchManager.filter.query = 'flowers';
    searchManager.filter.location.country = 'France';
    searchManager.filter.orientation = 'landscape';
    searchManager.applyPreset({
      deviceModels: ['Camera One', 'Camera Two'],
      mediaType: MediaType.Video,
      exifConditions: [{ field: 'iso', operator: 'gte', value: 800 }],
    });
    await searchManager.submit();
    const target = String(vi.mocked(goto).mock.calls[0][0]);
    const query = JSON.parse(new URL(target, 'https://test.invalid').searchParams.get('query')!);
    expect(query.filter).toMatchObject({
      country: { eq: 'France' },
      model: { in: ['Camera One', 'Camera Two'] },
      orientation: { eq: 'landscape' },
      iso: { gte: 800 },
      type: { eq: AssetTypeEnum.Video },
    });
    searchManager.reset();
    searchManager.setQuery(query);
    expect(searchManager.filter.query).toBe('flowers');
    expect(searchManager.filter.location.country).toBe('France');
    expect(searchManager.filter.deviceModels).toEqual(['Camera One', 'Camera Two']);
    expect(searchManager.filter.orientation).toBe('landscape');
    expect(searchManager.filter.mediaType).toBe(MediaType.Video);
    expect(searchManager.filter.exifConditions).toEqual([{ field: 'iso', operator: 'gte', value: 800 }]);
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
