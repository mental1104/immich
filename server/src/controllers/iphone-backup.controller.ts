import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IphoneBackupCommandDto, IphoneBackupProgress } from 'src/dtos/iphone-backup.dto.js';
import { Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { IphoneBackupService } from 'src/services/iphone-backup.service.js';

/** Fork 管理页专用控制面；不进入官方 OpenAPI/SDK，不改变现有手机接口。 */
@ApiExcludeController()
@Controller('admin/fork/iphone-backup')
export class IphoneBackupController {
  /** @param service 独立指纹批次服务，上传开关不由此控制器管理。 */
  constructor(private service: IphoneBackupService) {}

  /** @returns 管理员可见的真实指纹进度和批次状态；不创建任务。 */
  @Get()
  @Authenticated({ permission: Permission.QueueRead, admin: true })
  getProgress(): Promise<IphoneBackupProgress> {
    return this.service.getProgress();
  }

  /** @param dto 管理员提交的有界批次命令。 @returns 命令后的状态。 */
  @Put()
  @Authenticated({ permission: Permission.QueueUpdate, admin: true })
  command(@Body() dto: IphoneBackupCommandDto): Promise<IphoneBackupProgress> {
    return this.service.command(dto);
  }
}
