import { LocalizedLocationIndex, type LocalizedGeodataName } from './localized-location';

const city: LocalizedGeodataName = {
  geonameId: 2_867_714,
  kind: 'city',
  scope: 'global',
  name: 'Munich',
  country: 'Germany',
  state: 'Bavaria',
  localizedName: '慕尼黑',
  aliases: ['慕尼黑'],
};

describe('offline localized locations', () => {
  it('resolves a city with its country and state while retaining its original search value', () => {
    const index = new LocalizedLocationIndex([city]);
    expect(index.display('city', 'Munich', { country: 'Germany', state: 'Bavaria' })).toBe('慕尼黑');
    expect(index.searchTerms('city', 'Munich')).toEqual(['Munich', '慕尼黑']);
    expect(city.name).toBe('Munich');
  });

  it('falls back for missing names or conflicting context', () => {
    const index = new LocalizedLocationIndex([city]);
    expect(index.display('city', 'Munich', { country: 'United States' })).toBe('Munich');
    expect(index.display('city', 'Munich', { country: 'Germany', state: 'Berlin' })).toBe('Munich');
    expect(index.display('city', 'Unknown')).toBe('Unknown');
    expect(index.display('city', null)).toBe('');
  });

  it('does not infer uniqueness from incomplete Chinese coverage', () => {
    const index = new LocalizedLocationIndex([{ ...city, scope: 'state' }]);
    expect(index.display('city', 'Munich')).toBe('Munich');
    expect(index.display('city', 'Munich', { country: 'Germany' })).toBe('Munich');
    expect(index.display('city', 'Munich', { country: 'Germany', state: 'Bavaria' })).toBe('慕尼黑');
    expect(index.searchTerms('city', 'Munich')).toContain('慕尼黑');
  });

  it('keeps identical place names distinct by geography', () => {
    const index = new LocalizedLocationIndex([
      { ...city, scope: 'country' },
      { ...city, geonameId: 123, country: 'United States', scope: 'country', localizedName: '美国的同名地点' },
    ]);
    expect(index.display('city', 'Munich')).toBe('Munich');
    expect(index.display('city', 'Munich', { country: 'Germany' })).toBe('慕尼黑');
    expect(index.display('city', 'Munich', { country: 'United States' })).toBe('美国的同名地点');
  });

  it('does not translate a place that is ambiguous even within a state', () => {
    const index = new LocalizedLocationIndex([{ ...city, scope: 'none' }]);
    expect(index.display('city', 'Munich', { country: 'Germany', state: 'Bavaria' })).toBe('Munich');
  });

  it('can label countries while another country is selected', () => {
    const index = new LocalizedLocationIndex([
      { ...city, kind: 'country', name: 'Germany', localizedName: '德国', state: null },
    ]);
    expect(index.display('country', 'Germany', { country: 'China' })).toBe('德国');
  });
});
