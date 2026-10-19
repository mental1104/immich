import { shouldPlaySmallVideoOriginal, SMALL_VIDEO_MAX_BYTES } from '$lib/utils/video-playback';

describe('small video original playback', () => {
  it.each([1, SMALL_VIDEO_MAX_BYTES - 1, SMALL_VIDEO_MAX_BYTES])('plays %i bytes directly', (size) => {
    expect(shouldPlaySmallVideoOriginal(size, false)).toBe(true);
  });

  it.each([undefined, null, 0, -1, NaN, SMALL_VIDEO_MAX_BYTES + 1, 100 * 1024 * 1024])(
    'keeps HLS for unknown, invalid or large size %s',
    (size) => {
      expect(shouldPlaySmallVideoOriginal(size, false)).toBe(false);
    },
  );

  it('keeps HLS after an original playback error even for a small file', () => {
    expect(shouldPlaySmallVideoOriginal(1024, true)).toBe(false);
  });
});
