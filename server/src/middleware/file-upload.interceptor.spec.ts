import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import express from 'express';
import { Writable } from 'node:stream';
import { of } from 'rxjs';
import request from 'supertest';
import { RouteKey } from 'src/enum.js';
import { AuthRequest } from 'src/middleware/auth.guard.js';
import { FileUploadInterceptor } from 'src/middleware/file-upload.interceptor.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { factory } from 'test/small.factory.js';
import { newTestService } from 'test/utils.js';

/** 使用真实 multipart 解析器验证视频在写盘前被拒绝，而照片仍可完整接收。 */
describe('FileUploadInterceptor photos-only mode', () => {
  afterEach(() => vitest.unstubAllEnvs());

  it.each([
    ['clip.MOV', false, 503],
    ['clip.MOV', true, 503],
    ['photo.HEIC', false, 200],
    ['photo.JPG', true, 200],
  ] as const)('handles %s with filename override=%s and HTTP %s', async (filename, override, status) => {
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', 'fb1736b2-ee04-4675-b2a0-8101e519d802');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', '/photos');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_UPLOADS_ENABLED', 'true');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_VIDEOS_ENABLED', 'false');
    const { sut, mocks } = newTestService(AssetMediaService);
    mocks.library.get.mockResolvedValue(factory.library({ ownerId: authStub.admin.user.id }));
    vitest.spyOn(sut, 'getUploadFolder').mockReturnValue('/unused-test-directory');
    vitest.spyOn(sut, 'getUploadFilename').mockReturnValue(filename);
    // 用可完成的内存流代替真实磁盘，断言生产写流入口是否被调用。
    mocks.storage.createWriteStream.mockReturnValue(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
    const reflector = new Reflector();
    vitest.spyOn(reflector, 'get').mockReturnValue(RouteKey.Asset);
    const interceptor = new FileUploadInterceptor(
      reflector,
      sut,
      mocks.storage as unknown as StorageRepository,
      mocks.logger as unknown as LoggingRepository,
    );
    const app = express();
    // 只替换鉴权上下文；请求体仍由生产使用的 Multer 解析。
    app.post('/upload', async (req: AuthRequest, res) => {
      req.user = authStub.admin;
      const context = {
        getClass: () => AssetMediaService,
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      } as unknown as ExecutionContext;
      try {
        await interceptor.intercept(context, { handle: () => of(undefined) });
        res.sendStatus(200);
      } catch (error) {
        if (error instanceof HttpException) {
          res.status(error.getStatus()).json(error.getResponse());
          return;
        }
        throw error;
      }
    });

    const upload = request(app).post('/upload');
    if (override) {
      upload.field('filename', filename);
    }
    const response = await upload.attach('assetData', Buffer.from('not-a-real-private-video'), {
      filename: override ? 'opaque-upload' : filename,
    });
    expect(response.status).toBe(status);
    if (status === 503) {
      expect(response.body.message).toBe('Video backup is paused; photos only for now');
      expect(mocks.storage.createWriteStream).not.toHaveBeenCalled();
    } else {
      expect(mocks.storage.createWriteStream).toHaveBeenCalledExactlyOnceWith(`/unused-test-directory/${filename}`);
    }
    expect(mocks.asset.create).not.toHaveBeenCalled();
  });
});
