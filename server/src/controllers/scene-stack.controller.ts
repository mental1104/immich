import { Body, Controller, Header, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { SceneStackQueryDto } from 'src/dtos/scene-stack.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { SceneStackService } from 'src/services/scene-stack.service.js';

/** Fork专用只读展示合同，沿用现有登录及权限，不修改官方SDK。 */
@ApiExcludeController()
@Controller('fork/scene-stacks')
export class SceneStackController {
  /** @param service 外层分组证据读取服务。 */
  constructor(private service: SceneStackService) {}

  /** @param auth 当前登录。@param dto 桶内照片ID。@returns 完整且仍有效的外层分组。 */
  @Post('query')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead })
  query(@Auth() auth: AuthDto, @Body() dto: SceneStackQueryDto) {
    return this.service.query(auth, dto.ids);
  }
}
