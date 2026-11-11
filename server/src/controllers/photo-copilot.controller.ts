import { Body, Controller, Get, Header, Param, Post, Sse } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { PhotoCopilotMessageDto, PhotoCopilotOpenDto, PhotoCopilotParamsDto } from 'src/dtos/photo-copilot.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PhotoCopilotService } from 'src/services/photo-copilot.service.js';
import { UUIDParamDto } from 'src/validation.js';

/** Fork 专用照片对话入口；沿用 Immich 登录和资产权限，独立于官方 SDK。 */
@ApiExcludeController()
@Controller('fork/photo-copilot')
export class PhotoCopilotController {
  /** @param service 只读后台助手，不提供通用命令执行或元数据写入。 */
  constructor(private service: PhotoCopilotService) {}

  /** @returns 后台启用状态；不启动模型调用。 */
  @Get()
  @Authenticated({ permission: Permission.AssetRead })
  status() {
    return this.service.status();
  }

  /** @param auth 当前登录。@param params 照片 ID。@returns 当前用户在该照片上的历史会话列表。 */
  @Get('assets/:id/sessions')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead })
  list(@Auth() auth: AuthDto, @Param() params: UUIDParamDto) {
    return this.service.list(auth, params.id);
  }

  /** @param auth 当前 Immich 登录。@param params 照片 ID。@param dto 可选会话 ID。@returns 新建或恢复的会话快照。 */
  @Post('assets/:id/sessions')
  @Authenticated({ permission: Permission.AssetRead })
  open(@Auth() auth: AuthDto, @Param() params: UUIDParamDto, @Body() dto: PhotoCopilotOpenDto) {
    return this.service.open(auth, params.id, dto.sessionId);
  }

  /** @param auth 当前登录。@param params 照片及会话。@returns SSE 快照；客户端断开不会停止后台分析。 */
  @Sse('assets/:assetId/sessions/:id/events')
  @Authenticated({ permission: Permission.AssetRead })
  events(@Auth() auth: AuthDto, @Param() params: PhotoCopilotParamsDto) {
    return this.service.events(auth, params.assetId, params.id);
  }

  /** @param auth 当前登录。@param params 照片及会话。@param dto 用户消息。@returns 受理状态，文本经 SSE 流式输出。 */
  @Post('assets/:assetId/sessions/:id/messages')
  @Authenticated({ permission: Permission.AssetRead })
  send(@Auth() auth: AuthDto, @Param() params: PhotoCopilotParamsDto, @Body() dto: PhotoCopilotMessageDto) {
    return this.service.send(auth, params.assetId, params.id, dto.message);
  }

  /** @param auth 当前登录。@param params 照片及会话。@returns 停止受理状态，不直接声称任务已终止。 */
  @Post('assets/:assetId/sessions/:id/stop')
  @Authenticated({ permission: Permission.AssetRead })
  stop(@Auth() auth: AuthDto, @Param() params: PhotoCopilotParamsDto) {
    return this.service.stop(auth, params.assetId, params.id);
  }
}
