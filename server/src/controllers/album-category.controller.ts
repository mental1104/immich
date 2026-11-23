import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AlbumCategoryNameDto, AlbumGroupCategoryDto } from 'src/dtos/album-category.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AlbumCategoryService } from 'src/services/album-category.service.js';
import { UUIDParamDto } from 'src/validation.js';

/** Fork专用个人相簿目录入口；官方手机继续使用原搜索API，不要求识别新DTO或同步枚举。 */
@ApiExcludeController()
@Controller('fork/album-categories')
export class AlbumCategoryController {
  /** @param service 用户隔离的大组服务。 */
  constructor(private readonly service: AlbumCategoryService) {}

  /** @param auth 当前身份。@returns 当前账号的大组和分组归属。 */
  @Get()
  @Authenticated({ permission: Permission.AlbumRead })
  getState(@Auth() auth: AuthDto) {
    return this.service.getState(auth.user.id);
  }

  /** @param auth 当前身份。@param dto 大组名称。@returns 新大组。 */
  @Post()
  @Authenticated({ permission: Permission.AlbumCreate })
  create(@Auth() auth: AuthDto, @Body() dto: AlbumCategoryNameDto) {
    return this.service.create(auth.user.id, dto.name);
  }

  /** @param auth 当前身份。@param dto 分组及可选父归属。@returns 设置完成。 */
  @Put('group')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AlbumUpdate })
  assign(@Auth() auth: AuthDto, @Body() dto: AlbumGroupCategoryDto) {
    return this.service.assign(auth.user.id, dto);
  }

  /** @param auth 当前身份。@param params 大组ID。@param dto 新名称。@returns 改名后的大组。 */
  @Patch(':id')
  @Authenticated({ permission: Permission.AlbumUpdate })
  rename(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: AlbumCategoryNameDto) {
    return this.service.rename(auth.user.id, id, dto.name);
  }

  /** @param auth 当前身份。@param params 大组ID。@returns 删除完成，既有分组回默认。 */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AlbumDelete })
  delete(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.delete(auth.user.id, id);
  }
}
