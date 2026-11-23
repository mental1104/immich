import { UnauthorizedException } from '@nestjs/common';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { MediaAiReviewController } from 'src/controllers/media-ai-review.controller.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { controllerSetup, type ControllerContext } from 'test/utils.js';

/** 用真实 Nest HTTP 响应验证既有快照功能的会话、账户和文件边界。 */
describe(MediaAiReviewController.name, () => {
  const base = '/fork/media-ai-review';
  const owner = AuthFactory.from().session().build();
  const other = AuthFactory.from().session().build();
  const html = '<!doctype html><title>Local fixture</title>';
  let context: ControllerContext;
  let directory: string;

  /** 创建当前测试专用快照和控制器，不读取私人报告。 */
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'immich-media-review-'));
    await writeFile(path.join(directory, `${owner.user.id}.html`), html, { mode: 0o600 });
    context = await controllerSetup(MediaAiReviewController, []);
  });

  /** 隔离环境选项和登录替身，每个测试重新设置。 */
  beforeEach(() => {
    context.reset();
    vi.stubEnv('IMMICH_MEDIA_AI_REVIEW_DIR', directory);
  });

  /** 恢复环境并释放测试专用资源。 */
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  });

  /** 未登录时不可读取状态或数据。 */
  it('uses the Immich session guard', async () => {
    context.authenticate.mockRejectedValue(new UnauthorizedException());
    await request(context.getHttpServer()).get(`${base}/available`).expect(401);
    await request(context.getHttpServer()).get(`${base}/snapshot`).expect(401);
  });

  /** 只允许账户自己的快照，忽略客户端传入的其他用户标识。 */
  it('streams only the logged-in account snapshot with no cache or same-origin script privileges', async () => {
    context.authenticate.mockResolvedValue(owner);
    await request(context.getHttpServer()).get(`${base}/available`).expect(200, { available: true });
    await request(context.getHttpServer())
      .get(`${base}/snapshot`)
      .expect(200, html)
      .expect('Content-Type', /text\/html/)
      .expect('Cache-Control', 'private, no-store')
      .expect('Content-Security-Policy', /sandbox allow-scripts;/);

    context.authenticate.mockResolvedValue(other);
    await request(context.getHttpServer()).get(`${base}/available`).expect(200, { available: false });
    await request(context.getHttpServer()).get(`${base}/snapshot`).query({ owner: owner.user.id }).expect(404);
  });

  /** 即使守卫返回资产权限，从 API Key 或共享链接也无法取得账户快照。 */
  it('does not accept API keys or shared-link identities', async () => {
    for (const auth of [
      AuthFactory.from(owner.user).apiKey().build(),
      AuthFactory.from(owner.user).sharedLink().build(),
    ]) {
      context.authenticate.mockResolvedValue(auth);
      await request(context.getHttpServer()).get(`${base}/snapshot`).expect(404);
    }
  });

  /** 错误安装的符号链接不能从其他账户读取文件。 */
  it('does not follow a snapshot link', async () => {
    await symlink(`${owner.user.id}.html`, path.join(directory, `${other.user.id}.html`));
    context.authenticate.mockResolvedValue(other);
    await request(context.getHttpServer()).get(`${base}/snapshot`).expect(404);
  });
});
