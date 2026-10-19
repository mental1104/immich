import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { MapController } from 'src/controllers/map.controller.js';
import { Permission } from 'src/enum.js';
import { MapService } from 'src/services/map.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(MapController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(MapService);

  beforeAll(async () => {
    ctx = await controllerSetup(MapController, [{ provide: MapService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('offline Chinese geodata routes', () => {
    it.each(['/map/fork/localized-names', '/map/fork/search-places?name=成都'])(
      'requires authentication for %s',
      async (url) => {
        ctx.authenticate.mockRejectedValueOnce(new UnauthorizedException());
        const response = await request(ctx.getHttpServer()).get(encodeURI(url));
        expect(response.status).toBe(401);
        expect(service.getForkLocalizedNames).not.toHaveBeenCalled();
        expect(service.getForkSearchPlaces).not.toHaveBeenCalled();
      },
    );

    it('enforces map search permission', async () => {
      ctx.authenticate.mockRejectedValueOnce(new ForbiddenException());
      const response = await request(ctx.getHttpServer()).get('/map/fork/localized-names');
      expect(response.status).toBe(403);
      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ permission: Permission.MapSearch, sharedLinkRoute: false }),
        }),
      );
      expect(service.getForkLocalizedNames).not.toHaveBeenCalled();
    });

    it('rejects a missing place name', async () => {
      const response = await request(ctx.getHttpServer()).get('/map/fork/search-places');
      expect(response.status).toBe(400);
      expect(service.getForkSearchPlaces).not.toHaveBeenCalled();
    });

    it('accepts a Chinese place query', async () => {
      service.getForkSearchPlaces.mockResolvedValueOnce([]);
      const response = await request(ctx.getHttpServer()).get('/map/fork/search-places').query({ name: '成都' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
      expect(service.getForkSearchPlaces).toHaveBeenCalledWith({ name: '成都' });
    });
  });

  describe('GET /map/reverse-geocode', () => {
    it('should require a lat', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/map/reverse-geocode').query({ lon: 123 });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['lat'], message: 'Invalid input: expected number, received NaN' }]),
      );
      expect(service.reverseGeocode).not.toHaveBeenCalled();
    });

    it('should require a lat that is a number', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get('/map/reverse-geocode')
        .query({ lat: 'abc', lon: 123.456 });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['lat'], message: 'Invalid input: expected number, received NaN' }]),
      );
      expect(service.reverseGeocode).not.toHaveBeenCalled();
    });

    it('should require a lat that is in range', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get('/map/reverse-geocode')
        .query({ lat: 91, lon: 123.456 });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['lat'], message: 'Too big: expected number to be <=90' }]),
      );
      expect(service.reverseGeocode).not.toHaveBeenCalled();
    });

    it('should require a lon', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/map/reverse-geocode').query({ lat: 75 });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['lon'], message: 'Invalid input: expected number, received NaN' }]),
      );
      expect(service.reverseGeocode).not.toHaveBeenCalled();
    });
  });
});
