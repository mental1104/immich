import request from 'supertest';
import { vi } from 'vitest';
import { AssetMediaController } from 'src/controllers/asset-media.controller.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetMetadataKey } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { HlsService } from 'src/services/hls.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

const makeUploadDto = (options?: { omit: string }): Record<string, any> => {
  const dto: Record<string, any> = {
    fileCreatedAt: new Date().toISOString(),
    fileModifiedAt: new Date().toISOString(),
    isFavorite: 'false',
  };

  const omit = options?.omit;
  if (omit) {
    delete dto[omit];
  }

  return dto;
};

describe(AssetMediaController.name, () => {
  let ctx: ControllerContext;
  const assetData = Buffer.from('123');
  const filename = 'example.png';
  const service = mockBaseService(AssetMediaService);
  const hlsService = { getMainPlaylist: vi.fn() };

  beforeAll(async () => {
    ctx = await controllerSetup(AssetMediaController, [
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: AssetMediaService, useValue: service },
      { provide: HlsService, useValue: hlsService },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    hlsService.getMainPlaylist.mockReset();
    service.uploadAsset.mockResolvedValue({ status: AssetMediaStatus.DUPLICATE, id: factory.uuid() });

    ctx.reset();
  });

  afterEach(() => vi.unstubAllEnvs());

  describe('GET /assets/:id/video/playback', () => {
    it('returns an HLS playlist at the existing playback URL when enabled', async () => {
      vi.stubEnv('IMMICH_EXPERIMENTAL_IOS_HLS', 'true');
      const id = factory.uuid();
      const playlist = '#EXTM3U\n#EXT-X-VERSION:7\n';
      hlsService.getMainPlaylist.mockResolvedValue(playlist);

      const response = await request(ctx.getHttpServer()).get(`/assets/${id}/video/playback`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/vnd.apple.mpegurl');
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.text ?? response.body.toString('utf8')).toBe(playlist);
      expect(hlsService.getMainPlaylist).toHaveBeenCalledExactlyOnceWith(undefined, id, 'stream/');
      expect(service.playbackVideo).not.toHaveBeenCalled();
    });
  });

  describe('POST /assets', () => {
    it('should accept metadata', async () => {
      const mobileMetadata = { key: AssetMetadataKey.MobileApp, value: { iCloudId: '123' } };
      const { status } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({
          ...makeUploadDto(),
          metadata: JSON.stringify([mobileMetadata]),
        });

      expect(service.uploadAsset).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ metadata: [mobileMetadata] }),
        expect.objectContaining({ originalName: 'example.png' }),
        undefined,
      );

      expect(status).toBe(200);
    });

    it('should handle invalid metadata json', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({
          ...makeUploadDto(),
          metadata: 'not-a-string-string',
        });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['metadata'], message: 'Invalid input: expected JSON string, received string' },
        ]),
      );
    });

    it('should require `fileCreatedAt`', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto({ omit: 'fileCreatedAt' }) });
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['fileCreatedAt'], message: 'Invalid input: expected ISO 8601 datetime string, received undefined' },
        ]),
      );
    });

    it('should require `fileModifiedAt`', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field(makeUploadDto({ omit: 'fileModifiedAt' }));
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['fileModifiedAt'], message: 'Invalid input: expected ISO 8601 datetime string, received undefined' },
        ]),
      );
    });

    it('should accept a non-UTC timezone offset', async () => {
      const fileCreatedAt = '2026-05-28T19:51:20.555+02:00';
      const { status } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), fileCreatedAt });

      expect(status).toBe(200);
      expect(service.uploadAsset).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          fileCreatedAt: new Date(fileCreatedAt),
        }),
        expect.objectContaining({ originalName: 'example.png' }),
        undefined,
      );
    });

    it('should reject a timezone-less datetime', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), fileCreatedAt: '2026-05-28T19:51:20.555706' });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['fileCreatedAt'], message: 'Invalid input: expected ISO 8601 datetime string, received string' },
        ]),
      );
    });

    it('should throw if `isFavorite` is not a boolean', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), isFavorite: 'not-a-boolean' });
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['isFavorite'], message: 'Invalid option: expected one of "true"|"false"' },
        ]),
      );
    });

    it('should throw if `visibility` is not an enum', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), visibility: 'not-an-option' });
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['visibility'], message: expect.stringContaining('Invalid option: expected one of') },
        ]),
      );
    });

    // TODO figure out how to deal with `sendFile`

    // TODO figure out how to deal with `sendFile`
    describe('GET /assets/:id/thumbnail', () => {
      it('should redirect if size=original is requested', async () => {
        const { status } = await request(ctx.getHttpServer()).get(`/assets/${factory.uuid()}/thumbnail?size=original`);
        expect(status).toBe(302);
      });
    });
  });
});
