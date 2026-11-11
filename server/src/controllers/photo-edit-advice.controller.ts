import { Body, Controller, Get, Header, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiExcludeController } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PhotoEditFileParamsDto,
  PhotoEditUploadDto,
  PhotoEditVersionParamsDto,
} from 'src/dtos/photo-edit-advice.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PhotoEditAdviceService } from 'src/services/photo-edit-advice.service.js';
import { UUIDParamDto } from 'src/validation.js';

/** 独立工作台 API，公开协议只接受受权的资产、版本标识和上传字节。 */
@ApiExcludeController()
@Controller('fork/photo-edit-advice')
export class PhotoEditAdviceController {
  /** @param service 工作台保存、分析和入栈的服务。 */
  constructor(private service: PhotoEditAdviceService) {}

  /** @param auth 当前用户。@returns 工作台配置及项目列表。 */
  @Get()
  @Authenticated({ permission: Permission.AssetRead })
  @Header('Cache-Control', 'private, no-store')
  projects(@Auth() auth: AuthDto) {
    return this.service.projects(auth);
  }

  /** @param auth 当前用户。@param params 原片。@returns 原片的完整版本图数据。 */
  @Get('assets/:id')
  @Authenticated({ permission: Permission.AssetRead })
  @Header('Cache-Control', 'private, no-store')
  list(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.list(auth, id);
  }

  /** @param auth 当前用户。@param params 原片。@returns 从原片生成、已受理的 Codex 版本。 */
  @Post('assets/:id/generate')
  @Authenticated({ permission: Permission.AssetRead })
  generate(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.generate(auth, id);
  }

  /** @param auth 当前用户。@param params 原片。@param dto 版本资料。@param file 用户导出的后期文件。@returns 已保存版本。 */
  @Post('assets/:id/versions')
  @Authenticated({ permission: Permission.AssetRead })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 32 * 1024 * 1024, files: 1, fields: 3 } }))
  upload(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PhotoEditUploadDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.upload(auth, id, dto, file);
  }

  /** @param auth 当前用户。@param params 原片及版本。@returns 版本和可用报告。 */
  @Get('assets/:assetId/versions/:id')
  @Authenticated({ permission: Permission.AssetRead })
  @Header('Cache-Control', 'private, no-store')
  get(@Auth() auth: AuthDto, @Param() { assetId, id }: PhotoEditVersionParamsDto) {
    return this.service.get(auth, assetId, id);
  }

  /** @param auth 当前用户。@param params 原片及版本。@returns 私有文件流，按已定义文件类型下载或查看。 */
  @Get('assets/:assetId/versions/:id/files/:file')
  @Authenticated({ permission: Permission.AssetRead })
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  file(@Auth() auth: AuthDto, @Param() { assetId, id, file }: PhotoEditFileParamsDto) {
    return this.service.file(auth, assetId, id, file);
  }

  /** @param auth 当前用户。@param params 原片及版本。@returns 重新受理的分析状态。 */
  @Post('assets/:assetId/versions/:id/retry')
  @Authenticated({ permission: Permission.AssetRead })
  retry(@Auth() auth: AuthDto, @Param() { assetId, id }: PhotoEditVersionParamsDto) {
    return this.service.retry(auth, assetId, id);
  }

  /** @param auth 当前用户。@param params 原片及版本。@returns 已明确提交至原生叠放的手工版本。 */
  @Post('assets/:assetId/versions/:id/commit')
  @Authenticated({ permission: Permission.AssetUpload })
  commit(@Auth() auth: AuthDto, @Param() { assetId, id }: PhotoEditVersionParamsDto) {
    return this.service.commit(auth, assetId, id);
  }
}
