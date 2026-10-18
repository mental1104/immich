import { searchManager } from '$lib/managers/search-manager.svelte';

describe('SearchManager', () => {
  beforeEach(() => {
    localStorage.clear();
    searchManager.reset();
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
});
