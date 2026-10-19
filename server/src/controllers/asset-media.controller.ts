import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  ParseFilePipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type NextFunction, type Request, type Response } from 'express';
import type { UploadFiles } from 'src/types.js';
import { HLS_PLAYLIST_CONTENT_TYPE } from 'src/constants.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssetBulkUploadCheckResponseDto,
  AssetMediaResponseDto,
  AssetMediaStatus,
} from 'src/dtos/asset-media-response.dto.js';
import {
  AssetBulkUploadCheckDto,
  AssetMediaCreateDto,
  AssetMediaOptionsDto,
  AssetMediaSize,
} from 'src/dtos/asset-media.dto.js';
import { AssetDownloadOriginalDto } from 'src/dtos/asset.dto.js';
import { type AuthDto } from 'src/dtos/auth.dto.js';
import { ApiTag, ImmichHeader, Permission, RouteKey } from 'src/enum.js';
import { AssetUploadInterceptor } from 'src/middleware/asset-upload.interceptor.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { FileUploadInterceptor, getFiles } from 'src/middleware/file-upload.interceptor.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { HlsService } from 'src/services/hls.service.js';
import { ImmichFileResponse, sendFile } from 'src/utils/file.js';
import { FileNotEmptyValidator, UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class AssetMediaController {
  /**
   * 创建媒体 API 控制器，分别委托普通文件播放与 HLS 会话播放。
   * @param logger 文件响应错误日志组件。
   * @param service 原文件上传、缩略图和视频播放组件。
   * @param hlsService 已有 HLS 会话与播放列表组件。
   */
  constructor(
    private logger: LoggingRepository,
    private service: AssetMediaService,
    private hlsService: HlsService,
  ) {}

  @Post()
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @UseInterceptors(AssetUploadInterceptor, FileUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: ImmichHeader.Checksum,
    description: 'sha1 checksum that can be used for duplicate detection before the file is uploaded',
    required: false,
  })
  @ApiBody({ description: 'Asset Upload Information', type: AssetMediaCreateDto })
  @ApiResponse({
    status: 200,
    description: 'Asset is a duplicate',
    type: AssetMediaResponseDto,
  })
  @ApiResponse({
    status: 201,
    description: 'Asset uploaded successfully',
    type: AssetMediaResponseDto,
  })
  @Endpoint({
    summary: 'Upload asset',
    description: 'Uploads a new asset to the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async uploadAsset(
    @Auth() auth: AuthDto,
    @UploadedFiles(new ParseFilePipe({ validators: [new FileNotEmptyValidator(['assetData'])] })) files: UploadFiles,
    @Body() dto: AssetMediaCreateDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssetMediaResponseDto> {
    const { file, sidecarFile } = getFiles(files);
    const responseDto = await this.service.uploadAsset(auth, dto, file, sidecarFile);

    if (responseDto.status === AssetMediaStatus.DUPLICATE) {
      res.status(HttpStatus.OK);
    }

    return responseDto;
  }

  @Get(':id/original')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @Endpoint({
    summary: 'Download original asset',
    description: 'Downloads the original file of the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async downloadAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetDownloadOriginalDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.downloadOriginal(auth, id, dto), this.logger);
  }

  @Get(':id/thumbnail')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'View asset thumbnail',
    description:
      'Retrieve the thumbnail image for the specified asset. Viewing the fullsize thumbnail might redirect to downloadAsset, which requires a different permission.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async viewAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetMediaOptionsDto,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    if (dto.size === AssetMediaSize.Original) {
      this.logger.deprecate(
        'Calling the thumbnail endpoint with size=original is deprecated. Use the :id/original endpoint instead',
      );
      const [_, reqSearch] = req.url.split('?', 2);
      const redirSearchParams = new URLSearchParams(reqSearch);
      redirSearchParams.delete('size');
      return res.redirect('original?' + redirSearchParams.toString());
    }

    const viewThumbnailRes = await this.service.viewThumbnail(auth, id, dto);

    if (viewThumbnailRes instanceof ImmichFileResponse) {
      await sendFile(res, next, () => Promise.resolve(viewThumbnailRes), this.logger);
    } else {
      // viewThumbnailRes is a AssetMediaRedirectResponse
      // which redirects to the original asset or a specific size to make better use of caching
      const { targetSize } = viewThumbnailRes;
      const [reqPath, reqSearch] = req.url.split('?', 2);
      let redirPath: string;
      const redirSearchParams = new URLSearchParams(reqSearch);
      if (targetSize === 'original') {
        // relative path to this.downloadAsset
        redirPath = 'original';
        redirSearchParams.delete('size');
      } else if (Object.values(AssetMediaSize).includes(targetSize)) {
        redirPath = reqPath;
        redirSearchParams.set('size', targetSize);
      } else {
        throw new Error('Invalid targetSize: ' + targetSize);
      }
      const finalRedirPath = redirPath + '?' + redirSearchParams.toString();
      return res.redirect(finalRedirPath);
    }
  }

  /**
   * 在实验模式下以原视频播放 URL 返回 HLS 主列表，否则保持文件 Range 播放接口行为。
   * @param auth 当前已认证用户或共享链接上下文。
   * @param id 视频资产的 UUID。
   * @param res Express 响应对象，直接发送播放列表或视频文件。
   * @param next 原文件发送失败时的错误处理中间件入口。
   * @returns 无返回值，播放内容通过 Express 响应发送。
   */
  @Get(':id/video/playback')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'Play asset video',
    description: 'Streams the video file for the specified asset. This endpoint also supports byte range requests.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async playAssetVideo(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    if (process.env.IMMICH_EXPERIMENTAL_IOS_HLS === 'true') {
      const requestStartedAt = Date.now();
      this.logger.log('HLS request stage=ios_playback_playlist result=start');
      res.once('finish', () => {
        const contentLength = res.getHeader('content-length');
        this.logger.log(
          `HLS request stage=ios_playback_playlist_response result=sent status=${res.statusCode} bytes=${contentLength ?? 'unknown'} elapsedMs=${Date.now() - requestStartedAt}`,
        );
      });
      res.once('close', () => {
        if (!res.writableFinished) {
          this.logger.warn(
            `HLS request stage=ios_playback_playlist_response result=client_closed status=${res.statusCode} elapsedMs=${Date.now() - requestStartedAt}`,
          );
        }
      });
      // iOS 网络播放器请求原 /video/playback URL；使用 stream/ 相对路径复用已鉴权的 HLS 接口。
      try {
        const playlist = await this.hlsService.getMainPlaylist(auth, id, 'stream/');
        const sessionId = /stream\/([\w-]+)\//.exec(playlist)?.[1] ?? 'unknown';
        this.logger.log(
          `HLS request stage=ios_playback_playlist result=ready session=${sessionId} elapsedMs=${Date.now() - requestStartedAt}`,
        );
        res.header('Cache-Control', 'private, no-store');
        res.header('Content-Type', HLS_PLAYLIST_CONTENT_TYPE);
        res.status(HttpStatus.OK).send(playlist);
      } catch (error) {
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        this.logger.warn(
          `HLS request stage=ios_playback_playlist result=error error=${errorName} elapsedMs=${Date.now() - requestStartedAt}`,
        );
        throw error;
      }
      return;
    }

    await sendFile(res, next, () => this.service.playbackVideo(auth, id), this.logger);
  }

  @Post('bulk-upload-check')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Check bulk upload',
    description: 'Determine which assets have already been uploaded to the server based on their SHA1 checksums.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  @HttpCode(HttpStatus.OK)
  checkBulkUpload(
    @Auth() auth: AuthDto,
    @Body() dto: AssetBulkUploadCheckDto,
  ): Promise<AssetBulkUploadCheckResponseDto> {
    return this.service.bulkUploadCheck(auth, dto);
  }
}
