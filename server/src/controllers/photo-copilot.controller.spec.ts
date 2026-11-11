import { UnauthorizedException } from '@nestjs/common';
import { of } from 'rxjs';
import request from 'supertest';
import { PhotoCopilotController } from 'src/controllers/photo-copilot.controller.js';
import { PhotoCopilotService } from 'src/services/photo-copilot.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

/** 公开 HTTP 合同测试：沿用 Immich 登录规则，拒绝非法消息及客户端指定的服务器路径。 */
describe(PhotoCopilotController.name, () => {
  let context: ControllerContext;
  const service = { status: vi.fn(), list: vi.fn(), open: vi.fn(), send: vi.fn(), stop: vi.fn(), events: vi.fn() };
  const assetId = '00000000-0000-4000-8000-000000000001';
  const id = '00000000-0000-4000-8000-000000000002';
  const auth = AuthFactory.create();
  beforeAll(async () => {
    context = await controllerSetup(PhotoCopilotController, [{ provide: PhotoCopilotService, useValue: service }]);
    return () => context.close();
  });
  beforeEach(() => {
    context.reset();
    vi.clearAllMocks();
    context.authenticate.mockResolvedValue(auth);
  });

  /** 匿名不能读取状态；沿用原有鉴权失败响应，无额外配对。 */
  it('uses existing Immich authentication', async () => {
    context.authenticate.mockRejectedValue(new UnauthorizedException());
    await request(context.getHttpServer()).get('/fork/photo-copilot').expect(401);
    await request(context.getHttpServer())
      .get('/fork/photo-copilot/assets/' + assetId + '/sessions')
      .expect(401);
    expect(service.status).not.toHaveBeenCalled();
    expect(service.list).not.toHaveBeenCalled();
  });

  /** 历史列表带有登录身份和路由照片，返回可重开的会话摘要。 */
  it('lists saved sessions for the requested photo', async () => {
    const summaries = [{ id, title: 'Explain the light' }];
    service.list.mockResolvedValue(summaries);
    await request(context.getHttpServer())
      .get('/fork/photo-copilot/assets/' + assetId + '/sessions')
      .expect(200, summaries);
    expect(service.list).toHaveBeenCalledWith(auth, assetId);
  });

  /** 当前照片从 URL 进入服务层，请求无法覆盖服务端文件源。 */
  it('opens by asset ID and strips arbitrary paths from the body', async () => {
    service.open.mockResolvedValue({ id, assetId });
    await request(context.getHttpServer())
      .post(`/fork/photo-copilot/assets/${assetId}/sessions`)
      .send({ filePath: '/private/file.jpg' })
      .expect(201);
    expect(service.open).toHaveBeenCalledWith(auth, assetId, undefined);
  });

  /** 空消息和超长消息在进入模型层前被拒绝。 */
  it.each(['', ' '.repeat(4), 'x'.repeat(16_001), 'text\0'])('rejects invalid message text', async (message) => {
    await request(context.getHttpServer())
      .post(`/fork/photo-copilot/assets/${assetId}/sessions/${id}/messages`)
      .send({ message })
      .expect(400);
    expect(service.send).not.toHaveBeenCalled();
  });

  /** 合法消息及停止都明确携带原来的用户、照片和会话。 */
  it('routes messages and interruption to the same user and photo', async () => {
    service.send.mockResolvedValue({ id, assetId });
    service.stop.mockResolvedValue({ id, assetId });
    await request(context.getHttpServer())
      .post(`/fork/photo-copilot/assets/${assetId}/sessions/${id}/messages`)
      .send({ message: 'Explain the light' })
      .expect(201);
    await request(context.getHttpServer())
      .post(`/fork/photo-copilot/assets/${assetId}/sessions/${id}/stop`)
      .send({})
      .expect(201);
    expect(service.send).toHaveBeenCalledWith(auth, assetId, id, 'Explain the light');
    expect(service.stop).toHaveBeenCalledWith(auth, assetId, id);
  });

  /** 通过真实 Nest HTTP SSE 响应验证事件封装及现有鉴权。 */
  it('streams a snapshot over the native SSE endpoint', async () => {
    service.events.mockResolvedValue(of({ data: { id, assetId, status: 'completed' } }));
    const response = await request(context.getHttpServer())
      .get(`/fork/photo-copilot/assets/${assetId}/sessions/${id}/events`)
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);
    expect(response.text).toContain(`"assetId":"${assetId}"`);
    expect(service.events).toHaveBeenCalledWith(auth, assetId, id);
  });
});
