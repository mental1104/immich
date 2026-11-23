import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { SearchPresetDto } from 'src/dtos/search-preset.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { SearchPresetService } from 'src/services/search-preset.service.js';
import { UUIDParamDto } from 'src/validation.js';

/** Fork个人登记入口；不暴露给分享链接，不更改官方搜索API或移动SDK。 */
@ApiExcludeController()
@Controller('fork/search-presets')
export class SearchPresetController {
  /** @param service 当前账号登记管理。 */
  constructor(private readonly service: SearchPresetService) {}
  /** @param auth 当前身份。@returns 自有登记项。 */
  @Get()
  @Authenticated({ permission: Permission.UserPreferenceRead })
  getAll(@Auth() auth: AuthDto) {
    return this.service.getAll(auth.user.id);
  }
  /** @param auth 当前身份。@param dto 名称/条件。@returns 新登记项。 */
  @Post()
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  create(@Auth() auth: AuthDto, @Body() dto: SearchPresetDto) {
    return this.service.create(auth.user.id, dto);
  }
  /** @param auth 当前身份。@param params 自有项ID。@param dto 新值。@returns 修改后的项。 */
  @Patch(':id')
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  update(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: SearchPresetDto) {
    return this.service.update(auth.user.id, id, dto);
  }
  /** @param auth 当前身份。@param params 自有项ID。@returns 删除完成。 */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  delete(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.delete(auth.user.id, id);
  }
}
