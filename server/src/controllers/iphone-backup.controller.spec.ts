import { UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { IphoneBackupController } from 'src/controllers/iphone-backup.controller.js';
import { Permission } from 'src/enum.js';
import { IphoneBackupService } from 'src/services/iphone-backup.service.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

/** 验证真实路由鉴权元数据和请求边界；后台任务行为由隔离集成测试覆盖。 */
describe(IphoneBackupController.name, () => {
  let ctx: ControllerContext;
  const service = { getProgress: vi.fn(), command: vi.fn() };

  /** 建立 Nest 测试 HTTP 服务，保留真实 AuthGuard 和 Zod 请求校验。 */
  beforeAll(async () => {
    ctx = await controllerSetup(IphoneBackupController, [{ provide: IphoneBackupService, useValue: service }]);
  });
  afterAll(async () => ctx.close());
  beforeEach(() => {
    ctx.reset();
    service.getProgress.mockReset();
    service.command.mockReset();
  });

  it('requires admin queue-read authentication before reading progress', async () => {
    service.getProgress.mockResolvedValue({ enabled: false });
    const response = await request(ctx.getHttpServer()).get('/admin/fork/iphone-backup');
    expect(response.status).toBe(200);
    expect(ctx.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          adminRoute: true,
          sharedLinkRoute: false,
          permission: Permission.QueueRead,
        }),
      }),
    );
  });

  it('rejects unauthenticated requests without reading database progress', async () => {
    ctx.authenticate.mockRejectedValue(new UnauthorizedException());
    const response = await request(ctx.getHttpServer()).get('/admin/fork/iphone-backup');
    expect(response.status).toBe(401);
    expect(service.getProgress).not.toHaveBeenCalled();
  });

  it('rejects unbounded commands before submitting a job', async () => {
    const response = await request(ctx.getHttpServer())
      .put('/admin/fork/iphone-backup')
      .send({ command: 'start', limit: 1001 });
    expect(response.status).toBe(400);
    expect(service.command).not.toHaveBeenCalled();
  });

  it('requires admin queue-update permission and forwards a bounded command', async () => {
    service.command.mockResolvedValue({ state: 'queued' });
    const response = await request(ctx.getHttpServer())
      .put('/admin/fork/iphone-backup')
      .send({ command: 'start', limit: 24 });
    expect(response.status).toBe(200);
    expect(ctx.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          adminRoute: true,
          sharedLinkRoute: false,
          permission: Permission.QueueUpdate,
        }),
      }),
    );
    expect(service.command).toHaveBeenCalledWith({ command: 'start', limit: 24 });
  });
});
