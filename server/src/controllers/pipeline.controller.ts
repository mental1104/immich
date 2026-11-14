import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { QueueNameParamDto } from 'src/dtos/queue.dto.js';
import { Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { QueuePauseRepository } from 'src/repositories/queue-pause.repository.js';

/** Fork 管理请求，长期维护必须显式选择 persistent。 */
export class PipelinePauseCommandDto extends createZodDto(
  z.object({ mode: z.enum(['temporary', 'persistent', 'resume']) }),
) {}

/** 管理照片处理链路暂停期限；不进入官方 OpenAPI/SDK。 */
@ApiExcludeController()
@Controller('admin/fork/pipeline')
export class PipelineController {
  /** @param repository 暂停意图及原生队列控制器。 */
  constructor(private repository: QueuePauseRepository) {}

  /** @returns 当前期限、长期维护状态及策略开关；仅管理员可读。 */
  @Get()
  @Authenticated({ permission: Permission.QueueRead, admin: true })
  getPolicy() {
    return this.repository.getPolicy();
  }

  /** @param params 已校验的队列名。 @param dto 显式暂停模式。 @returns 更新后的策略。 */
  @Put(':name')
  @Authenticated({ permission: Permission.QueueUpdate, admin: true })
  command(@Param() params: QueueNameParamDto, @Body() dto: PipelinePauseCommandDto) {
    return this.repository.command(params.name, dto.mode);
  }
}
