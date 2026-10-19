import { DEFAULT_DECODING_INFO, selectEfficientLevels, type Level } from './media-capabilities-manager.svelte';

const decodingInfo = (powerEfficient: boolean, supported = true): MediaCapabilitiesDecodingInfo => ({
  ...DEFAULT_DECODING_INFO,
  powerEfficient,
  supported,
});

describe('selectEfficientLevels', () => {
  it('prefers efficient HEVC over lower-bitrate H.264 at the same resolution', () => {
    const levels: Level[] = [
      { videoCodec: 'avc1.64001e', width: 854, height: 480, bitrate: 800_000, frameRate: 60 },
      { videoCodec: 'hvc1.1.6.L90.B0', width: 854, height: 480, bitrate: 1_200_000, frameRate: 60 },
    ];

    expect(selectEfficientLevels(levels, [decodingInfo(true), decodingInfo(true)])).toEqual(new Set([1]));
  });

  it('falls back to efficient H.264 when HEVC is not power efficient', () => {
    const levels: Level[] = [
      { videoCodec: 'avc1.64001e', width: 854, height: 480, bitrate: 800_000, frameRate: 60 },
      { videoCodec: 'hvc1.1.6.L90.B0', width: 854, height: 480, bitrate: 1_200_000, frameRate: 60 },
    ];

    expect(selectEfficientLevels(levels, [decodingInfo(true), decodingInfo(false)])).toEqual(new Set([0]));
  });

  it('does not select HEVC when the browser does not report it as supported', () => {
    const levels: Level[] = [
      { videoCodec: 'avc1.64001e', width: 854, height: 480, bitrate: 800_000, frameRate: 60 },
      { videoCodec: 'hvc1.1.6.L90.B0', width: 854, height: 480, bitrate: 1_200_000, frameRate: 60 },
    ];

    expect(selectEfficientLevels(levels, [decodingInfo(true), decodingInfo(true, false)])).toEqual(new Set([0]));
  });

  it('keeps the preferred efficient codec at each available resolution', () => {
    const levels: Level[] = [
      { videoCodec: 'avc1.64001e', width: 854, height: 480, bitrate: 800_000, frameRate: 60 },
      { videoCodec: 'hvc1.1.6.L90.B0', width: 854, height: 480, bitrate: 1_200_000, frameRate: 60 },
      { videoCodec: 'hvc1.1.6.L120.B0', width: 1920, height: 1080, bitrate: 4_500_000, frameRate: 60 },
    ];

    expect(selectEfficientLevels(levels, [decodingInfo(true), decodingInfo(true), decodingInfo(true)])).toEqual(
      new Set([1, 2]),
    );
  });
});
