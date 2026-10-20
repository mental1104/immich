import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HlsVideoResolution, VideoCodec } from 'src/enum.js';
import { HlsService } from 'src/services/hls.service.js';
import { eiffelTower, train, waterfall } from 'test/fixtures/media.stub.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const sessionId = '00000000-0000-0000-0000-000000000000';

describe(HlsService.name, () => {
  let sut: HlsService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(HlsService));
  });

  describe('getMainPlaylist', () => {
    const auth = factory.auth();
    const assetId = 'asset-1';

    const allCodecs = [VideoCodec.Av1, VideoCodec.Hevc, VideoCodec.H264];
    const allResolutions = [
      HlsVideoResolution.p480,
      HlsVideoResolution.p720,
      HlsVideoResolution.p1080,
      HlsVideoResolution.p1440,
      HlsVideoResolution.p2160,
    ];

    const setup = (
      asset: typeof eiffelTower | typeof waterfall,
      videoCodecs?: VideoCodec[],
      resolutions?: HlsVideoResolution[],
    ) => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { realtime: { enabled: true, videoCodecs, resolutions } },
      });
      mocks.videoStream.getForMainPlaylist.mockResolvedValue(asset);
      mocks.crypto.randomUUID.mockReturnValue(sessionId);
      mocks.websocket.serverSend.mockImplementation((event, ...rest) => {
        if (event !== 'HlsSessionRequest') {
          return;
        }

        const { sessionId: id } = rest[0] as { sessionId: string };
        queueMicrotask(() => sut.onSessionResult({ sessionId: id }));
      });
    };

    it('offers AV1, HEVC, and H.264 when AV1 is configured and the accelerator supports it', async () => {
      setup(eiffelTower, allCodecs);
      const playlist = await sut.getMainPlaylist(auth, assetId);
      expect(playlist.match(/\/(\d+)\/playlist\.m3u8/g)).toEqual([
        '/2/playlist.m3u8',
        '/0/playlist.m3u8',
        '/1/playlist.m3u8',
        '/3/playlist.m3u8',
        '/4/playlist.m3u8',
        '/6/playlist.m3u8',
        '/7/playlist.m3u8',
        '/5/playlist.m3u8',
        '/8/playlist.m3u8',
      ]);
      expect(playlist).toContain('BANDWIDTH=1080000');
    });

    it('omits AV1 when it is not in the configured codecs', async () => {
      setup(eiffelTower);
      const playlist = await sut.getMainPlaylist(auth, assetId);
      expect(playlist.match(/\/(\d+)\/playlist\.m3u8/g)).toEqual([
        '/2/playlist.m3u8',
        '/1/playlist.m3u8',
        '/4/playlist.m3u8',
        '/7/playlist.m3u8',
        '/5/playlist.m3u8',
        '/8/playlist.m3u8',
      ]);
    });

    it('offers a 360p H.264 variant for hover previews without changing configured resolutions', async () => {
      setup(eiffelTower, [VideoCodec.H264], [HlsVideoResolution.p480]);
      const playlist = await sut.getMainPlaylist(auth, assetId, '', true);

      expect(playlist).toContain('RESOLUTION=360x640');
      expect(playlist).toContain(`${sessionId}/17/playlist.m3u8`);
      expect(playlist).toContain('RESOLUTION=480x852');
    });

    it('prefixes variant URLs without changing the existing HLS endpoint output', async () => {
      setup(eiffelTower);
      const result = await sut.getMainPlaylist(auth, assetId, 'stream/');

      expect(result.match(/stream\/[\w-]+\/(\d+)\/playlist\.m3u8/g)).toEqual([
        `stream/${sessionId}/2/playlist.m3u8`,
        `stream/${sessionId}/1/playlist.m3u8`,
        `stream/${sessionId}/4/playlist.m3u8`,
        `stream/${sessionId}/7/playlist.m3u8`,
        `stream/${sessionId}/5/playlist.m3u8`,
        `stream/${sessionId}/8/playlist.m3u8`,
      ]);
      expect(result).not.toContain('stream/stream/');
    });

    it('offers every resolution up to the source and derives 4K codec levels (waterfall, 4K, 29.83fps)', async () => {
      setup(waterfall, allCodecs, allResolutions);
      const playlist = await sut.getMainPlaylist(auth, assetId);
      expect(playlist.match(/\/(\d+)\/playlist\.m3u8/g)).toEqual([
        '/2/playlist.m3u8',
        '/0/playlist.m3u8',
        '/1/playlist.m3u8',
        '/3/playlist.m3u8',
        '/4/playlist.m3u8',
        '/6/playlist.m3u8',
        '/7/playlist.m3u8',
        '/5/playlist.m3u8',
        '/9/playlist.m3u8',
        '/8/playlist.m3u8',
        '/10/playlist.m3u8',
        '/12/playlist.m3u8',
        '/11/playlist.m3u8',
        '/13/playlist.m3u8',
        '/14/playlist.m3u8',
      ]);
    });

    it('throws BadRequestException when realtime transcoding is disabled', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { realtime: { enabled: false } } });
      await expect(sut.getMainPlaylist(auth, assetId)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException when asset is not yet ready for streaming', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { realtime: { enabled: true } } });
      await expect(sut.getMainPlaylist(auth, assetId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMediaPlaylist', () => {
    const auth = factory.auth();
    const assetId = 'asset-1';
    const fixtures = [eiffelTower, waterfall, train];

    it.each(fixtures)('creates one-second independently seekable segments for $originalPath', async (data) => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(data);
      const playlist = await sut.getMediaPlaylist(auth, assetId, sessionId, 0);
      expect(playlist).toContain('#EXT-X-TARGETDURATION:1');
      expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
      expect(playlist).toContain('#EXT-X-ENDLIST');
      const segmentDurations = playlist
        .matchAll(/#EXTINF:([\d.]+)/g)
        .map(([, duration]) => Number(duration))
        .toArray();
      expect(segmentDurations.length).toBeGreaterThan(1);
      expect(Math.max(...segmentDurations)).toBeLessThanOrEqual(1.05);
    });

    it('throws NotFoundException when the session/asset cannot be loaded', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      await expect(sut.getMediaPlaylist(auth, assetId, sessionId, 0)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('prewarms transcoding at the segment containing the hinted position', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(eiffelTower);
      await sut.getMediaPlaylist(auth, assetId, sessionId, 1, 10.5);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsSegmentRequest', {
        sessionId,
        assetId,
        variantIndex: 1,
        segmentIndex: 10,
      });
    });

    it('does not prewarm a new variant before the client requests its actual seek segment', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getSession.mockResolvedValue({ id: sessionId, assetId } as never);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      await sut.getSegment(auth, assetId, sessionId, 0, 'seg_5.m4s');

      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(eiffelTower);
      await sut.getMediaPlaylist(auth, assetId, sessionId, 1);
      expect(mocks.websocket.serverSend).not.toHaveBeenCalledWith('HlsSegmentRequest', expect.anything());
    });

    it('prewarms the first segment when no position hint is provided', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(eiffelTower);
      await sut.getMediaPlaylist(auth, assetId, sessionId, 1);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsSegmentRequest', {
        sessionId,
        assetId,
        variantIndex: 1,
        segmentIndex: 0,
      });
    });

    it('does not prewarm the variant the session is already playing', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getSession.mockResolvedValue({ id: sessionId, assetId } as never);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      await sut.getSegment(auth, assetId, sessionId, 1, 'seg_5.m4s');

      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(eiffelTower);
      await sut.getMediaPlaylist(auth, assetId, sessionId, 1, 12.5);
      expect(mocks.websocket.serverSend).not.toHaveBeenCalledWith('HlsSegmentRequest', expect.anything());
    });
  });

  describe('getSegment', () => {
    const auth = factory.auth();
    const assetId = 'asset-1';
    const variantIndex = 0;

    beforeEach(() => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getSession.mockResolvedValue({ id: sessionId, assetId } as never);
      mocks.storage.checkFileExists.mockResolvedValue(true);
    });

    it('emits HlsHeartbeat with segmentIndex 0 for the first init.mp4 request', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 0,
      });
    });

    it('waits for init.mp4 readiness instead of the first media segment', async () => {
      mocks.storage.checkFileExists.mockResolvedValue(false);
      const pending = sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4');
      await new Promise((resolve) => setImmediate(resolve));

      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsSegmentRequest', {
        sessionId,
        assetId,
        variantIndex,
        segmentIndex: 0,
      });
      sut.onInitResult({ sessionId, variantIndex });

      await expect(pending).resolves.toBeDefined();
    });

    it('does not wait after a media segment appears between existence checks', async () => {
      mocks.storage.checkFileExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await expect(sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_0.m4s')).resolves.toBeDefined();
      expect(mocks.websocket.serverSend).not.toHaveBeenCalledWith('HlsSegmentRequest', expect.anything());
      expect(mocks.storage.checkFileExists).toHaveBeenCalledTimes(2);
    });

    it('does not wait after init.mp4 appears between existence checks', async () => {
      mocks.storage.checkFileExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await expect(sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4')).resolves.toBeDefined();
      expect(mocks.websocket.serverSend).not.toHaveBeenCalledWith('HlsSegmentRequest', expect.anything());
      expect(mocks.storage.checkFileExists).toHaveBeenCalledTimes(2);
    });

    it('emits HlsHeartbeat with the parsed segment number for seg_K.m4s', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_5.m4s');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 5,
      });
    });

    it('returns lastRequested + 1 for init.mp4 without a target segment', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_5.m4s');
      mocks.websocket.serverSend.mockClear();
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 6,
      });
    });

    it('updates lastRequested on a backward-seek segment request', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_5.m4s');
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_3.m4s');
      mocks.websocket.serverSend.mockClear();
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 4,
      });
    });

    it('tracks segment state per session independently', async () => {
      await sut.getSegment(auth, assetId, 'session-a', variantIndex, 'seg_5.m4s');
      await sut.getSegment(auth, assetId, 'session-b', variantIndex, 'seg_2.m4s');
      mocks.websocket.serverSend.mockClear();
      await sut.getSegment(auth, assetId, 'session-a', variantIndex, 'init.mp4');
      await sut.getSegment(auth, assetId, 'session-b', variantIndex, 'init.mp4');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId: 'session-a',
        variantIndex,
        segmentIndex: 6,
      });
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId: 'session-b',
        variantIndex,
        segmentIndex: 3,
      });
    });

    it('rejects pending waiters for the previous variant on variant change', async () => {
      mocks.storage.checkFileExists.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      const pending = sut.getSegment(auth, assetId, sessionId, 0, 'seg_1.m4s');
      await new Promise((resolve) => setImmediate(resolve));
      await sut.getSegment(auth, assetId, sessionId, 1, 'seg_1.m4s');

      await expect(pending).rejects.toThrow('Variant changed');
    });

    it('throws NotFoundException when the session does not exist', async () => {
      mocks.videoStream.getSession.mockReset();
      await expect(sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('uses the initSegment hint for init.mp4', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4', 7);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 7,
      });
    });

    it('prefers the initSegment hint over the lastRequested + 1 fallback', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_5.m4s'); // fallback would be 6
      mocks.websocket.serverSend.mockClear();
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4', 10);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 10,
      });
    });

    it('ignores the initSegment hint for media segment requests (the filename wins)', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_5.m4s', 99);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 5,
      });
    });
  });

  describe('endSession', () => {
    it('emits HlsSessionEnd', async () => {
      const auth = factory.auth();
      const assetId = 'asset-1';
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      await sut.endSession(auth, assetId, sessionId);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsSessionEnd', { sessionId });
    });
  });
});
