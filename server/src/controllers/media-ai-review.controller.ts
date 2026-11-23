import { Controller, Get, Header, NotFoundException, StreamableFile } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';

const cache = 'private, no-store';
const content =
  "sandbox allow-scripts; frame-ancestors 'self'; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src blob: data:; base-uri 'none'; form-action 'none'";
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;

/** 通过 Immich 自身的登录会话为当前用户读取私有评审快照；不读取正式图库数据库中的评审表。 */
@ApiExcludeController()
@Controller('fork/media-ai-review')
export class MediaAiReviewController {
  /** @param auth Immich 登录身份。@returns 当前会话是否有已配置的可读快照。 */
  @Get('available')
  @Header('Cache-Control', cache)
  @Authenticated({ permission: Permission.AssetRead })
  async available(@Auth() auth: AuthDto) {
    const snapshot = await this.openSnapshot(auth);
    if (snapshot) await snapshot.file.close();
    return { available: Boolean(snapshot) };
  }

  /** @param auth Immich 登录身份。@returns 该用户的只读快照流，不允许客户端传入文件名。 */
  @Get('snapshot')
  @Header('Cache-Control', cache)
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', content)
  @Authenticated({ permission: Permission.AssetRead })
  async snapshot(@Auth() auth: AuthDto): Promise<StreamableFile> {
    const snapshot = await this.openSnapshot(auth);
    if (!snapshot) throw new NotFoundException('Media review snapshot is not available');
    return new StreamableFile(snapshot.file.createReadStream(), {
      type: 'text/html; charset=utf-8',
      length: snapshot.size,
    });
  }

  /** @param auth 已鉴权的身份。@returns 仅供网页会话读取的目录及用户键；其他身份为空。 */
  private reviewSource(auth: AuthDto) {
    const root = process.env.IMMICH_MEDIA_AI_REVIEW_DIR;
    const id = auth.user.id;
    if (root && path.isAbsolute(root) && auth.session && !auth.sharedLink && !auth.apiKey && uuid.test(id)) {
      return { root, id };
    }
  }

  /**
  @param auth 当前会话及所有者；共享链接和 API Key 都不能打开完整评审快照。
  @returns 当前账户的普通文件；未启用或无可读文件时为空，调用方负责关闭句柄。
  */
  private async openSnapshot(auth: AuthDto) {
    const source = this.reviewSource(auth);
    if (!source) return;
    const { root, id } = source;

    // 只打开已配置目录中的当前用户文件；拒绝链接和非普通文件，避免跟随意外挂载。
    const file = await open(
      path.join(root, `${id}.html`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => null);
    if (!file) return;
    const info = await file.stat().catch(() => null);
    if (!info?.isFile() || info.size === 0 || info.size > 32 * 1024 * 1024) {
      await file.close();
      return;
    }
    return { file, size: info.size };
  }
}
