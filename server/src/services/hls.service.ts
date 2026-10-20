import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { VideoPacketInfo, VideoStreamInfo } from 'src/types.js';
import {
  HLS_PREVIEW_RESOLUTION,
  HLS_SEGMENT_DURATION,
  HLS_SEGMENT_FILENAME_REGEX,
  HLS_VARIANTS,
  HLS_VERSION,
} from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import { CacheControl, ImmichWorker, Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { PendingEvents } from 'src/utils/event.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { getCodecString, getOutputSize } from 'src/utils/media.js';

type AssetWithStreamInfo = { videoStream: VideoStreamInfo & { timeBase: number }; packets: VideoPacketInfo };
type Segmentation = { fps: number; framesPerSegment: number; segmentCount: number; segmentDuration: number };
type ApiSession = { lastRequestedSegment: number | null; lastVariantIndex: number | null };

@Injectable()
export class HlsService extends BaseService {
  private pendingSegments = new PendingEvents<'HlsSegmentResult'>({ timeoutMs: 15_000 });
  private pendingInits = new PendingEvents<'HlsInitResult'>({ timeoutMs: 15_000 });
  private pendingSessions = new PendingEvents<'HlsSessionResult'>({ timeoutMs: 5000 });
  private sessions = new Map<string, ApiSession>();

  @OnEvent({ name: 'HlsSessionResult', server: true, workers: [ImmichWorker.Api] })
  onSessionResult(event: ArgOf<'HlsSessionResult'>) {
    this.pendingSessions.complete(event.sessionId, event);
    if (!event.error) {
      return;
    }

    this.sessions.delete(event.sessionId);
    this.pendingSegments.rejectByPrefix(`${event.sessionId}:`, event.error);
    this.pendingInits.rejectByPrefix(`${event.sessionId}:`, event.error);
  }

  @OnEvent({ name: 'HlsSessionEnd', server: true, workers: [ImmichWorker.Api] })
  onSessionEnd({ sessionId }: ArgOf<'HlsSessionEnd'>) {
    this.sessions.delete(sessionId);
    this.pendingSegments.rejectByPrefix(`${sessionId}:`, 'Session ended');
    this.pendingInits.rejectByPrefix(`${sessionId}:`, 'Session ended');
  }

  @OnEvent({ name: 'HlsSegmentResult', server: true, workers: [ImmichWorker.Api] })
  onSegmentResult(event: ArgOf<'HlsSegmentResult'>) {
    this.pendingSegments.complete(this.getSegmentKey(event), event);
  }

  @OnEvent({ name: 'HlsInitResult', server: true, workers: [ImmichWorker.Api] })
  onInitResult(event: ArgOf<'HlsInitResult'>) {
    this.pendingInits.complete(this.getInitKey(event), event);
  }

  /**
   * 为可访问的视频创建 HLS 会话并返回多码率主播放列表。
   * @param auth 视频访问权限上下文。
   * @param assetId 需要播放的视频 UUID。
   * @param variantPathPrefix 子播放列表 URL 前缀；默认空字符串保持原 HLS 接口兼容。
   * @returns 包含分支播放列表相对 URL 的 UTF-8 文本，配置或元数据不可用时抛出 HTTP 异常。
   */
  async getMainPlaylist(auth: AuthDto, assetId: string, variantPathPrefix = '', includePreviewVariant = false) {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });
    const { ffmpeg } = await this.getConfig({ withCache: true });
    if (!ffmpeg.realtime.enabled) {
      throw new BadRequestException('Real-time transcoding is not enabled');
    }

    const asset = await this.videoStreamRepository.getForMainPlaylist(assetId);
    if (!asset) {
      throw new NotFoundException('Asset metadata is not yet ready for streaming');
    }

    // Sharing the sessionId allows only one microservices worker to successfully insert to the session table.
    // The microservices worker that creates a session owns the transcoding lifecycle for it.
    const sessionId = this.cryptoRepository.randomUUID();
    this.websocketRepository.serverSend('HlsSessionRequest', { sessionId, assetId, ownerId: auth.user.id });
    await this.pendingSessions.wait(sessionId);
    this.trackSession(sessionId);

    return this.generateMainPlaylist(sessionId, ffmpeg, asset, variantPathPrefix, includePreviewVariant);
  }

  async getMediaPlaylist(auth: AuthDto, assetId: string, sessionId: string, variantIndex: number, position?: number) {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });

    const asset = await this.videoStreamRepository.getForMediaPlaylist(assetId, sessionId);
    if (!asset) {
      throw new NotFoundException('Asset not found or metadata not yet ready for streaming');
    }

    const segmentation = this.getSegmentation(asset);
    const hintedSegment = position === undefined ? undefined : this.positionToSegmentIndex(segmentation, position);
    this.prewarmVariant(assetId, sessionId, variantIndex, hintedSegment);

    return this.generateMediaPlaylist(asset, segmentation);
  }

  /**
   * 返回 HLS 初始化文件或媒体分片；先注册就绪监听再复查文件，避免错过完成事件。
   * @param auth 已认证的资源访问上下文。
   * @param assetId 原始视频 ID。
   * @param sessionId 当前 HLS 播放会话 ID。
   * @param variantIndex 播放档位索引。
   * @param filename init.mp4 或 seg_N.m4s 文件名。
   * @param initSegment 可选的初始化目标片段索引，供 Seek 使用。
   * @returns 可供 HTTP 控制器发送的文件响应；分片超时或会话失效时拒绝。
   */
  async getSegment(
    auth: AuthDto,
    assetId: string,
    sessionId: string,
    variantIndex: number,
    filename: string,
    initSegment?: number,
  ) {
    const requestStartedAt = Date.now();
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });

    const session = await this.videoStreamRepository.getSession(sessionId);
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const variantDir = StorageCore.getHlsVariantFolder({ ownerId: auth.user.id, sessionId, variantIndex });
    const path = join(variantDir, filename);
    const response = new ImmichFileResponse({
      path,
      contentType: 'video/mp4',
      cacheControl: CacheControl.PrivateWithCache,
    });

    const apiSession = this.trackSession(sessionId, variantIndex);
    const segmentIndex = this.getSegmentIndex(apiSession, filename, initSegment);
    this.websocketRepository.serverSend('HlsHeartbeat', { sessionId, variantIndex, segmentIndex });

    if (await this.storageRepository.checkFileExists(path, constants.R_OK)) {
      if (filename === 'init.mp4' || segmentIndex === 0) {
        this.logger.log(
          `HLS timing stage=api_file session=${sessionId} variant=${variantIndex} file=${filename} cacheHit=true requestMs=${Date.now() - requestStartedAt}`,
        );
      }
      return response;
    }

    const isInit = filename === 'init.mp4';
    const key = isInit
      ? this.getInitKey({ sessionId, variantIndex })
      : this.getSegmentKey({ sessionId, variantIndex, segmentIndex });
    const pending = isInit ? this.pendingInits.wait(key) : this.pendingSegments.wait(key);
    // 首次检查与注册监听之间可能恰好完成文件重命名；监听已注册后复查两种分片。
    if (await this.storageRepository.checkFileExists(path, constants.R_OK)) {
      if (isInit) {
        this.pendingInits.complete(key, { sessionId, variantIndex });
      } else {
        this.pendingSegments.complete(key, { sessionId, variantIndex, segmentIndex });
      }
    } else {
      this.websocketRepository.serverSend('HlsSegmentRequest', { sessionId, assetId, variantIndex, segmentIndex });
    }
    await pending;
    if (isInit || segmentIndex === 0) {
      this.logger.log(
        `HLS timing stage=api_file session=${sessionId} variant=${variantIndex} file=${filename} cacheHit=false requestMs=${Date.now() - requestStartedAt}`,
      );
    }

    return response;
  }

  async endSession(auth: AuthDto, assetId: string, sessionId: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });

    this.websocketRepository.serverSend('HlsSessionEnd', { sessionId });
  }

  /**
   * 根据视频流元数据、转码设置与 URL 前缀组装 HLS 主播放列表。
   * @param sessionId 本次播放会话 UUID。
   * @param ffmpeg 当前允许的 HLS 分辨率、编码器等转码设置。
   * @param asset 视频的流信息及分帧元数据。
   * @param variantPathPrefix 相对于请求 URL 的子播放列表路径前缀。
   * @returns 包含各播放档位的 HLS 主播放列表字符串。
   */
  private generateMainPlaylist(
    sessionId: string,
    ffmpeg: ConfigFFmpegDto,
    asset: AssetWithStreamInfo,
    variantPathPrefix: string,
    includePreviewVariant: boolean,
  ) {
    const fps = (asset.packets.packetCount * asset.videoStream.timeBase) / asset.packets.totalDuration;
    const roundedFps = fps.toFixed(3);
    const sourceResolution = Math.min(asset.videoStream.height, asset.videoStream.width);
    const targetResolution = Math.max(sourceResolution, HLS_VARIANTS[0].resolution);
    const lines = ['#EXTM3U', `#EXT-X-VERSION:${HLS_VERSION}`, '#EXT-X-INDEPENDENT-SEGMENTS'];
    const { videoCodecs, resolutions } = ffmpeg.realtime;
    const variants = HLS_VARIANTS.map((variant, index) => ({ ...variant, index })).sort(
      (a, b) => a.bitrate - b.bitrate,
    );
    for (const { index: i, resolution, bitrate, codec } of variants) {
      const isPreviewVariant = includePreviewVariant && resolution === HLS_PREVIEW_RESOLUTION;
      if (
        resolution > targetResolution ||
        !videoCodecs.includes(codec) ||
        (!isPreviewVariant && !resolutions.includes(resolution))
      ) {
        continue;
      }
      const { width, height } = getOutputSize(asset.videoStream, resolution);
      const codecString = getCodecString(codec, width, height, fps);
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bitrate * 1.35)},RESOLUTION=${width}x${height},CODECS="${codecString},mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=${roundedFps}`,
        `${variantPathPrefix}${sessionId}/${i}/playlist.m3u8`,
      );
    }
    lines.push('');

    if (lines.length === 4) {
      throw new NotFoundException('No supported variants for this video');
    }

    return lines.join('\n');
  }

  private getSegmentation({ videoStream, packets }: AssetWithStreamInfo): Segmentation {
    const fps = (packets.packetCount * videoStream.timeBase) / packets.totalDuration;
    const framesPerSegment = Math.ceil(HLS_SEGMENT_DURATION * fps);
    const segmentCount = Math.ceil(packets.outputFrames / framesPerSegment);
    return { fps, framesPerSegment, segmentCount, segmentDuration: framesPerSegment / fps };
  }

  private positionToSegmentIndex({ segmentDuration, segmentCount }: Segmentation, position: number) {
    return Math.min(Math.max(Math.floor(position / segmentDuration), 0), segmentCount - 1);
  }

  private generateMediaPlaylist({ packets }: AssetWithStreamInfo, segmentation: Segmentation) {
    const { fps, framesPerSegment, segmentCount, segmentDuration: fullSegmentDuration } = segmentation;
    const lastSegmentFrames = packets.outputFrames - framesPerSegment * (segmentCount - 1);
    const lastSegmentDuration = lastSegmentFrames / fps;

    const lines = [
      '#EXTM3U',
      `#EXT-X-VERSION:${HLS_VERSION}`,
      '#EXT-X-INDEPENDENT-SEGMENTS',
      `#EXT-X-TARGETDURATION:${HLS_SEGMENT_DURATION}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MAP:URI="init.mp4"',
    ];

    for (let i = 0; i < segmentCount - 1; i++) {
      lines.push(`#EXTINF:${fullSegmentDuration.toFixed(6)},`, `seg_${i}.m4s`);
    }
    lines.push(`#EXTINF:${lastSegmentDuration.toFixed(6)},`, `seg_${segmentCount - 1}.m4s`, '#EXT-X-ENDLIST', '');

    return lines.join('\n');
  }

  private prewarmVariant(assetId: string, sessionId: string, variantIndex: number, hintedSegment?: number) {
    const session = this.sessions.get(sessionId);
    // Initial playback can prewarm before the client asks for its first file.
    // On a quality switch, wait for the client's init/segment request: its
    // actual seek position can differ from the playlist hint and restarting a
    // speculative transcode would discard work before the first segment.
    if (session && session.lastVariantIndex !== null) {
      return;
    }

    const nextSegment = session && session.lastRequestedSegment !== null ? session.lastRequestedSegment + 1 : undefined;
    const segmentIndex = hintedSegment ?? nextSegment ?? 0;
    if (segmentIndex !== undefined) {
      this.websocketRepository.serverSend('HlsSegmentRequest', { sessionId, assetId, variantIndex, segmentIndex });
    }
  }

  private getSegmentKey({ sessionId, variantIndex, segmentIndex }: ArgOf<'HlsSegmentResult'>) {
    return `${sessionId}:${variantIndex}:${segmentIndex}`;
  }

  private getInitKey({ sessionId, variantIndex }: ArgOf<'HlsInitResult'>) {
    return `${sessionId}:${variantIndex}:init`;
  }

  private getSegmentIndex(session: ApiSession, filename: string, initSegment?: number) {
    if (filename.endsWith('.mp4')) {
      // We need to know where to start transcoding, but the init.mp4 has no segment number in its name.
      // We can infer this from the last requested segment, but this can be inaccurate given the client
      // can load cached segments without reaching out to the server. `initSegment` acts as a hint to
      // remove ambiguity when possible.
      return initSegment ?? (session.lastRequestedSegment ?? -1) + 1;
    }
    const segmentIndex = Number.parseInt(HLS_SEGMENT_FILENAME_REGEX.exec(filename)![1]);
    session.lastRequestedSegment = segmentIndex;
    return segmentIndex;
  }

  private trackSession(id: string, variantIndex: number | null = null) {
    const session = this.sessions.get(id);
    if (!session) {
      const newSession = { lastRequestedSegment: null, lastVariantIndex: variantIndex };
      this.sessions.set(id, newSession);
      return newSession;
    }

    if (session.lastVariantIndex !== null && session.lastVariantIndex !== variantIndex) {
      this.pendingSegments.rejectByPrefix(`${id}:${session.lastVariantIndex}:`, 'Variant changed');
      this.pendingInits.rejectByPrefix(`${id}:${session.lastVariantIndex}:`, 'Variant changed');
    }
    session.lastVariantIndex = variantIndex;
    return session;
  }
}
