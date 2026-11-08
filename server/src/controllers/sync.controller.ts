import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { SyncAckDeleteDto, SyncAckDto, SyncAckSetDto, SyncStreamDto } from 'src/dtos/sync.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { GlobalExceptionFilter } from 'src/middleware/global-exception.filter.js';
import { SyncService } from 'src/services/sync.service.js';

@ApiTags(ApiTag.Sync)
@Controller('sync')
export class SyncController {
  constructor(
    private service: SyncService,
    private errorService: GlobalExceptionFilter,
  ) {}

  @Post('stream')
  @Authenticated({ permission: Permission.SyncStream })
  @Header('Content-Type', 'application/jsonlines+json')
  // 增量很少时，压缩器可能一直缓冲到请求结束，客户端无法及时解析已写出的检查点。
  @Header('Cache-Control', 'no-transform')
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Stream sync changes',
    description:
      'Retrieve a JSON lines streamed response of changes for synchronization. This endpoint is used by the mobile app to efficiently stay up to date with changes.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  /**
   * 逐行输出同步变更，不让压缩器延迟发送客户端需要及时确认的检查点。
   * @param auth 已通过原有权限校验的当前用户及会话。
   * @param req 当前请求，仅在失败时交给原有异常处理器。
   * @param res 按 JSONL 输出的响应；成功时由同步服务结束，错误保留原处理流程。
   * @param dto 请求的同步实体类型及可选重置标记，不在控制器中改写。
   * @returns 同步处理结束的 Promise；异常由既有处理器转换为响应。
   */
  async getSyncStream(@Auth() auth: AuthDto, @Req() req: Request, @Res() res: Response, @Body() dto: SyncStreamDto) {
    try {
      await this.service.stream(auth, res, dto);
    } catch (error: Error | any) {
      this.errorService.handleError(req, res, error);
    }
  }

  @Get('ack')
  @Authenticated({ permission: Permission.SyncCheckpointRead })
  @Endpoint({
    summary: 'Retrieve acknowledgements',
    description: 'Retrieve the synchronization acknowledgments for the current session.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getSyncAck(@Auth() auth: AuthDto): Promise<SyncAckDto[]> {
    return this.service.getAcks(auth);
  }

  @Post('ack')
  @Authenticated({ permission: Permission.SyncCheckpointUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Acknowledge changes',
    description:
      'Send a list of synchronization acknowledgements to confirm that the latest changes have been received.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  sendSyncAck(@Auth() auth: AuthDto, @Body() dto: SyncAckSetDto) {
    return this.service.setAcks(auth, dto);
  }

  @Delete('ack')
  @Authenticated({ permission: Permission.SyncCheckpointDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete acknowledgements',
    description: 'Delete specific synchronization acknowledgments.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deleteSyncAck(@Auth() auth: AuthDto, @Body() dto: SyncAckDeleteDto): Promise<void> {
    return this.service.deleteAcks(auth, dto);
  }
}
