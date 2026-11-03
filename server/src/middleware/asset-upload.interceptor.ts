import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Response } from 'express';
import { of } from 'rxjs';
import { AssetMediaResponseDto, AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { ImmichHeader } from 'src/enum.js';
import { AuthenticatedRequest } from 'src/middleware/auth.guard.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { fromMaybeArray } from 'src/utils/request.js';

@Injectable()
/** 在解析原片前执行内容预检及可选备份准备门禁，不改变普通上传默认行为。 */
export class AssetUploadInterceptor implements NestInterceptor {
  constructor(private service: AssetMediaService) {}

  /**
   * 先复用已知内容，再检查目标用户是否仍处于指纹准备阶段。
   * @param context 经过鉴权的 HTTP 请求和响应上下文。
   * @param next 后续 multipart 解析及上传处理。
   * @returns 重复资产响应或后续处理流；准备中抛出 503，避免应用接收原片。
   */
  async intercept(context: ExecutionContext, next: CallHandler<any>) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const res = context.switchToHttp().getResponse<Response<AssetMediaResponseDto>>();

    const checksum = fromMaybeArray(req.headers[ImmichHeader.Checksum]);
    const response = await this.service.getUploadAssetIdByChecksum(req.user, checksum);
    if (response) {
      res.status(200);
      return of({ status: AssetMediaStatus.DUPLICATE, id: response.id });
    }

    await this.service.checkIphoneBackupUploadAccess(req.user);
    return next.handle();
  }
}
