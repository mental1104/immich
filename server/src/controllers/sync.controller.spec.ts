import compression from 'compression';
import express from 'express';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createBrotliDecompress, createGunzip } from 'node:zlib';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import { SyncController } from 'src/controllers/sync.controller.js';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { GlobalExceptionFilter } from 'src/middleware/global-exception.filter.js';
import { SyncService, send } from 'src/services/sync.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(SyncController.name, () => {
  let ctx: ControllerContext;
  const syncService = mockBaseService(SyncService);
  const errorService = { handleError: vi.fn() };

  beforeAll(async () => {
    ctx = await controllerSetup(SyncController, [
      { provide: SyncService, useValue: syncService },
      { provide: GlobalExceptionFilter, useValue: errorService },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    syncService.resetAllMocks();
    errorService.handleError.mockReset();
    ctx.reset();
  });

  describe('POST /sync/stream', () => {
    /** 验证协商压缩后，客户端仍能在同步结束前解析首个检查点；不访问数据库或真实照片。 */
    it.each(['br', 'gzip'])('should deliver a JSON line before completion when accepting %s', async (encoding) => {
      const app = express();
      app.use(compression());
      // 使用生产的压缩中间件包住真实控制器，覆盖响应头对实际字节输出的影响。
      app.use((req, res) => ctx.getHttpServer().emit('request', req, res));

      const release = Promise.withResolvers<void>();
      const checkpoint = {
        type: SyncEntityType.SyncAckV1 as const,
        ackType: SyncEntityType.AssetV2,
        ids: ['00000000-0000-4000-8000-000000000001'] as [string],
        data: {},
      };
      const lines: string[] = [];
      let pending = '';
      let ended = false;
      let streamError: Error | undefined;
      let contentEncoding: string | undefined;

      /** auth 为模拟鉴权结果；res 为真实 HTTP 响应。等待测试释放后才允许发送同步结束。 */
      syncService.stream.mockImplementationOnce(async (_auth, res) => {
        await send(res, checkpoint);
        await release.promise;
        await send(res, { type: SyncEntityType.SyncCompleteV1, ids: ['complete'], data: {} });
        res.end();
      });

      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address() as AddressInfo;
      /** 响应按实际 Content-Encoding 解码，只把完整 JSONL 行交给断言。 */
      const client = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/sync/stream',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept-Encoding': encoding },
        },
        (response) => {
          contentEncoding = response.headers['content-encoding'];
          const body =
            contentEncoding === 'br'
              ? response.pipe(createBrotliDecompress())
              : contentEncoding === 'gzip'
                ? response.pipe(createGunzip())
                : response;
          body.setEncoding('utf8');
          /** chunk 为解码后的文本；跨块残余保留到下一块，模拟客户端逐行读取。 */
          body.on('data', (chunk: string) => {
            pending += chunk;
            const completeLines = pending.split('\n');
            pending = completeLines.pop()!;
            lines.push(...completeLines);
          });
          body.on('end', () => {
            ended = true;
          });
          body.on('error', (error: Error) => {
            streamError = error;
          });
        },
      );
      client.on('error', (error: Error) => {
        streamError = error;
      });

      try {
        client.end(JSON.stringify({ types: [SyncRequestType.AssetsV2] }));
        // 服务端故意不结束响应；首行必须独立到达，不能等压缩缓冲区最终刷新。
        await vi.waitFor(() => expect(lines).toHaveLength(1), { timeout: 2000 });
        expect(streamError).toBeUndefined();
        expect(ended).toBe(false);
        expect(contentEncoding).toBeUndefined();
        expect(JSON.parse(lines[0])).toEqual({
          type: checkpoint.type,
          ack: `${checkpoint.ackType}|${checkpoint.ids[0]}`,
          data: {},
        });

        release.resolve();
        await vi.waitFor(() => expect(ended).toBe(true));
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[1]).type).toBe(SyncEntityType.SyncCompleteV1);
        expect(ctx.authenticate).toHaveBeenCalled();
      } finally {
        // 失败时同样解除服务端等待，避免留下悬挂请求或监听套接字。
        release.resolve();
        client.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });

    it('should require sync request type enums', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/sync/stream')
        .send({ types: ['invalid'] });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['types', 0], message: expect.stringContaining('Invalid option: expected one of') },
        ]),
      );
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });

  describe('POST /sync/ack', () => {
    it('should not allow more than 1,000 entries', async () => {
      const acks = Array.from({ length: 1001 }, (_, i) => `ack-${i}`);
      const { status, body } = await request(ctx.getHttpServer()).post('/sync/ack').send({ acks });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['acks'], message: 'Too big: expected array to have <=1000 items' }]),
      );
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });

  describe('DELETE /sync/ack', () => {
    it('should require sync response type enums', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .delete('/sync/ack')
        .send({ types: ['invalid'] });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['types', 0], message: expect.stringContaining('Invalid option: expected one of') },
        ]),
      );
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });
});
