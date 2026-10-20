import {
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ZodValidationException } from 'nestjs-zod';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { HLS_PLAYLIST_CONTENT_TYPE } from 'src/constants.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  HlsPlaylistHeaderDto,
  HlsSegmentHeaderDto,
  HlsSegmentParamDto,
  HlsSessionParamDto,
  HlsVariantParamDto,
} from 'src/dtos/streaming.dto.js';
import { ApiTag, ImmichHeader, Permission, RouteKey } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { HlsService } from 'src/services/hls.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class VideoStreamController {
  constructor(
    private logger: LoggingRepository,
    private service: HlsService,
  ) {}

  @Get(':id/video/stream/main.m3u8')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Header('Cache-Control', 'no-cache')
  @Header('Content-Type', HLS_PLAYLIST_CONTENT_TYPE)
  @ApiProduces(HLS_PLAYLIST_CONTENT_TYPE)
  @ApiQuery({ name: 'preview', required: false, type: Boolean })
  @Endpoint({
    summary: 'Get HLS main playlist',
    description: 'Returns an HLS main playlist with all available variants for the asset.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  async getMainPlaylist(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Query('preview') preview?: string) {
    const requestStartedAt = Date.now();
    try {
      const playlist = await this.service.getMainPlaylist(auth, id, '', preview === 'true');
      const sessionId = /\/([\w-]+)\/\d+\/playlist\.m3u8/.exec(playlist)?.[1] ?? 'unknown';
      this.logger.log(
        `HLS request stage=main_playlist result=ready session=${sessionId} elapsedMs=${Date.now() - requestStartedAt}`,
      );
      return playlist;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn(
        `HLS request stage=main_playlist result=error error=${errorName} elapsedMs=${Date.now() - requestStartedAt}`,
      );
      throw error;
    }
  }

  @Get(':id/video/stream/:sessionId/:variantIndex/playlist.m3u8')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Header('Cache-Control', 'no-cache')
  @Header('Content-Type', HLS_PLAYLIST_CONTENT_TYPE)
  @ApiProduces(HLS_PLAYLIST_CONTENT_TYPE)
  @Endpoint({
    summary: 'Get HLS media playlist',
    description: 'Returns an HLS media playlist for one variant of the streaming session.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  async getMediaPlaylist(
    @Auth() auth: AuthDto,
    @Param() { id, sessionId, variantIndex }: HlsVariantParamDto,
    @Headers() headers: HlsPlaylistHeaderDto,
  ) {
    const requestStartedAt = Date.now();
    try {
      headers = HlsPlaylistHeaderDto.create(headers);
    } catch (error) {
      throw new ZodValidationException(error);
    }
    try {
      const playlist = await this.service.getMediaPlaylist(
        auth,
        id,
        sessionId,
        variantIndex,
        headers[ImmichHeader.HlsPosition],
      );
      const segmentCount = (playlist.match(/#EXTINF:/g) || []).length;
      this.logger.log(
        `HLS request stage=media_playlist result=ready session=${sessionId} variant=${variantIndex} position=${headers[ImmichHeader.HlsPosition] ?? 'none'} segments=${segmentCount} elapsedMs=${Date.now() - requestStartedAt}`,
      );
      return playlist;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn(
        `HLS request stage=media_playlist result=error session=${sessionId} variant=${variantIndex} error=${errorName} elapsedMs=${Date.now() - requestStartedAt}`,
      );
      throw error;
    }
  }

  @Get(':id/video/stream/:sessionId/:variantIndex/:filename')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'Get HLS segment or init file',
    description: 'Streams an HLS init segment (init.mp4) or media segment (seg_N.m4s).',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  async getSegment(
    @Auth() auth: AuthDto,
    @Param() { id, sessionId, variantIndex, filename }: HlsSegmentParamDto,
    @Headers() headers: HlsSegmentHeaderDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    try {
      headers = HlsSegmentHeaderDto.create(headers);
    } catch (error) {
      throw new ZodValidationException(error);
    }
    const requestStartedAt = Date.now();
    const match = /^seg_(\d+)\.m4s$/.exec(filename);
    const segmentIndex = match ? Number(match[1]) : undefined;
    const shouldLogResponse =
      filename === 'init.mp4' || (segmentIndex !== undefined && (segmentIndex <= 2 || segmentIndex % 10 === 0));
    if (shouldLogResponse) {
      this.logger.log(`HLS request stage=segment_start session=${sessionId} variant=${variantIndex} file=${filename}`);
      res.once('finish', () => {
        const contentLength = res.getHeader('content-length');
        this.logger.log(
          `HLS request stage=segment_response result=sent session=${sessionId} variant=${variantIndex} file=${filename} status=${res.statusCode} bytes=${contentLength ?? 'unknown'} elapsedMs=${Date.now() - requestStartedAt}`,
        );
      });
      res.once('close', () => {
        if (!res.writableFinished) {
          this.logger.warn(
            `HLS request stage=segment_response result=client_closed session=${sessionId} variant=${variantIndex} file=${filename} status=${res.statusCode} elapsedMs=${Date.now() - requestStartedAt}`,
          );
        }
      });
    }
    let file: Awaited<ReturnType<HlsService['getSegment']>>;
    try {
      file = await this.service.getSegment(
        auth,
        id,
        sessionId,
        variantIndex,
        filename,
        headers[ImmichHeader.HlsInitSegment],
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn(
        `HLS request stage=segment_ready result=error session=${sessionId} variant=${variantIndex} file=${filename} error=${errorName} elapsedMs=${Date.now() - requestStartedAt}`,
      );
      if (error instanceof Error && error.message === 'Request timed out') {
        throw new GatewayTimeoutException('HLS segment was not ready before the request timed out');
      }
      throw error;
    }

    if (shouldLogResponse) {
      this.logger.log(
        `HLS request stage=segment_ready result=ready session=${sessionId} variant=${variantIndex} file=${filename} waitMs=${Date.now() - requestStartedAt}`,
      );
    }

    await sendFile(res, next, () => file, this.logger);
  }

  @Delete(':id/video/stream/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'End HLS streaming session',
    description: 'Releases server resources for the streaming session.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  async endSession(@Auth() auth: AuthDto, @Param() { id, sessionId }: HlsSessionParamDto) {
    await this.service.endSession(auth, id, sessionId);
  }
}
