import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import path from 'node:path';
import picomatch from 'picomatch';
import sanitize from 'sanitize-filename';
import type { UploadFile, UploadRequest } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { Asset, AuthSharedLink } from 'src/database.js';
import {
  AssetBulkUploadCheckResponseDto,
  AssetMediaResponseDto,
  AssetMediaStatus,
  AssetRejectReason,
  AssetUploadAction,
} from 'src/dtos/asset-media-response.dto.js';
import {
  AssetBulkUploadCheckDto,
  AssetMediaCreateDto,
  AssetMediaOptionsDto,
  AssetMediaSize,
  UploadFieldName,
} from 'src/dtos/asset-media.dto.js';
import { AssetDownloadOriginalDto } from 'src/dtos/asset.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AssetFileType,
  AssetVisibility,
  CacheControl,
  ChecksumAlgorithm,
  DatabaseLock,
  JobName,
  Permission,
  StorageFolder,
} from 'src/enum.js';
import { AuthRequest } from 'src/middleware/auth.guard.js';
import { BaseService } from 'src/services/base.service.js';
import { firstDateTime } from 'src/services/metadata.service.js';
import { requireUploadAccess } from 'src/utils/access.js';
import { asUploadRequest, onBeforeLink } from 'src/utils/asset.util.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { ImmichFileResponse, getFileNameWithoutExtension, getFilenameExtension } from 'src/utils/file.js';
import {
  IphoneBackupConfig,
  getIphoneBackupConfig,
  getIphoneBackupPath,
  isWithinDirectory,
  logIphoneBackupAudit,
} from 'src/utils/iphone-backup.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { fromChecksum } from 'src/utils/request.js';

export interface AssetMediaRedirectResponse {
  targetSize: AssetMediaSize | 'original';
}

/** 已验证归属和导入范围的备份目的地，只由管理员环境配置创建。 */
interface IphoneBackupTarget extends IphoneBackupConfig {
  exclusionPatterns: string[];
}

@Injectable()
/** 处理媒体上传和读取；显式启用的备份库在既有鉴权下接收其所有者的新上传。 */
export class AssetMediaService extends BaseService {
  /**
   * 准备指纹期间在 multipart 解析之前拒绝目标用户的新上传；其他用户与共享链接不受影响。
   * @param auth 当前请求鉴权；本方法不修改用户会话或已有资产。
   * @returns 允许上传时正常返回；暂停中的目标用户收到可重试的 HTTP 503。
   */
  async checkIphoneBackupUploadAccess(auth: AuthDto): Promise<void> {
    if (process.env.IMMICH_FORK_IPHONE_BACKUP_UPLOADS_ENABLED !== 'false' || auth.sharedLink) {
      return;
    }
    const config = getIphoneBackupConfig();
    if (!config) {
      return;
    }
    const library = await this.libraryRepository.get(config.libraryId);
    if (library?.ownerId === auth.user.id) {
      throw new ServiceUnavailableException('Photo backup is being prepared; retry later');
    }
  }
  /**
   * 使用请求头内容哈希提前判重，并记录应用尚未解析上传文件的结果。
   * @param auth 当前用户鉴权，查重仍遵守原有用户范围。
   * @param checksum 可选的十六进制或 Base64 内容 SHA-1。
   * @returns 已有资产结果；没有哈希或没有匹配时返回 undefined；不代表网络未发送请求体。
   */
  async getUploadAssetIdByChecksum(auth: AuthDto, checksum?: string): Promise<AssetMediaResponseDto | undefined> {
    if (!checksum) {
      return;
    }

    const assetId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, fromChecksum(checksum));
    if (!assetId) {
      return;
    }

    logIphoneBackupAudit(this.logger, { event: 'header_duplicate', ownerId: auth.user.id, assetId, bodyParsed: false });

    return { id: assetId, status: AssetMediaStatus.DUPLICATE };
  }

  canUploadFile({ auth, fieldName, file, body }: UploadRequest): true {
    requireUploadAccess(auth);

    const filename = body.filename || file.originalName;

    switch (fieldName) {
      case UploadFieldName.ASSET_DATA: {
        if (mimeTypes.isAsset(filename)) {
          return true;
        }
        break;
      }

      case UploadFieldName.SIDECAR_DATA: {
        if (mimeTypes.isSidecar(filename)) {
          return true;
        }
        break;
      }

      case UploadFieldName.PROFILE_DATA: {
        if (mimeTypes.isProfile(filename)) {
          return true;
        }
        break;
      }
    }

    this.logger.error(`Unsupported file type ${filename}`);
    throw new BadRequestException(`Unsupported file type ${filename}`);
  }

  getUploadFilename({ auth, fieldName, file, body }: UploadRequest): string {
    requireUploadAccess(auth);

    const extension = getFilenameExtension(body.filename || file.originalName);
    const lookup = {
      [UploadFieldName.ASSET_DATA]: extension,
      [UploadFieldName.SIDECAR_DATA]: '.xmp',
      [UploadFieldName.PROFILE_DATA]: extension,
    };

    return sanitize(`${file.uuid}${lookup[fieldName]}`);
  }

  getUploadFolder({ auth, fieldName, file }: UploadRequest): string {
    auth = requireUploadAccess(auth);

    let folder = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, file.uuid);
    if (fieldName === UploadFieldName.PROFILE_DATA) {
      folder = StorageCore.getFolderLocation(StorageFolder.Profile, auth.user.id);
    }

    this.storageRepository.mkdirSync(folder);

    return folder;
  }

  async onUploadError(request: AuthRequest, file: Express.Multer.File) {
    const uploadFilename = this.getUploadFilename(asUploadRequest(request, file));
    const uploadFolder = this.getUploadFolder(asUploadRequest(request, file));
    const uploadPath = `${uploadFolder}/${uploadFilename}`;

    await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [uploadPath] } });
  }

  /**
   * 选择普通上传或指定用户的外部库备份；默认行为保持不变。
   * @param auth 当前用户鉴权，共享链接上传不改变归属。
   * @param dto 既有上传字段，不增加客户端必填参数。
   * @param file 已接收完整且由服务端计算内容哈希的暂存文件。
   * @param sidecarFile 可选 XMP 暂存文件。
   * @returns 创建或重复资产结果；配置失败时清理暂存文件并抛错。
   */
  async uploadAsset(
    auth: AuthDto,
    dto: AssetMediaCreateDto,
    file: UploadFile,
    sidecarFile?: UploadFile,
  ): Promise<AssetMediaResponseDto> {
    logIphoneBackupAudit(this.logger, {
      event: 'upload_received',
      ownerId: auth.user.id,
      uploadId: file.uuid,
      mediaBytes: file.size,
      sidecarBytes: sidecarFile?.size ?? 0,
    });
    let backup: IphoneBackupTarget | undefined;
    try {
      await this.checkIphoneBackupUploadAccess(auth);
      const config = getIphoneBackupConfig();
      if (config && !auth.sharedLink) {
        const library = await this.libraryRepository.get(config.libraryId);
        if (!library) {
          throw new BadRequestException('Configured iPhone backup library is unavailable');
        }
        if (library.ownerId === auth.user.id) {
          // 要求管理员预先创建并挂载根目录，不从客户端接受任意服务器路径。
          const root = await this.storageRepository.realpath(config.root);
          const importPaths = await Promise.all(
            library.importPaths.map((folder) => this.storageRepository.realpath(folder)),
          );
          if (importPaths.every((folder) => !isWithinDirectory(folder, root))) {
            throw new BadRequestException('iPhone backup root is outside the library import paths');
          }
          backup = { ...config, root, exclusionPatterns: library.exclusionPatterns };
        }
      }
    } catch (error) {
      await this.jobRepository.queue({
        name: JobName.FileDelete,
        data: { files: [file.originalPath, sidecarFile?.originalPath] },
      });
      throw error;
    }

    if (backup) {
      const target = backup;
      // 与外部库扫描共用跨进程锁：内容检查、发布文件和建档必须保持这个顺序。
      return this.databaseRepository.withLock(DatabaseLock.ForkIphoneBackup, () =>
        this.storeUpload(auth, dto, file, sidecarFile, target),
      );
    }
    return this.storeUpload(auth, dto, file, sidecarFile);
  }

  /**
   * 执行上传建档及原有后处理；外部库分支由调用者持有发布锁。
   * @param auth 已鉴权用户，仍需通过原有上传权限检查。
   * @param dto 上传元数据，不修改。
   * @param file 完整暂存文件，备份成功后安排删除此副本。
   * @param sidecarFile 可选 XMP 暂存文件。
   * @param backup 显式启用且验证过归属的目标，缺省时沿用普通上传。
   * @returns 已创建或已存在的资产 ID；失败清理本次文件与资产记录。
   */
  private async storeUpload(
    auth: AuthDto,
    dto: AssetMediaCreateDto,
    file: UploadFile,
    sidecarFile?: UploadFile,
    backup?: IphoneBackupTarget,
  ): Promise<AssetMediaResponseDto> {
    let asset: Asset | undefined;
    const published: string[] = [];
    try {
      await this.requireAccess({
        auth,
        permission: Permission.AssetUpload,
        // do not need an id here, but the interface requires it
        ids: [auth.user.id],
      });

      if (backup) {
        const duplicateId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, file.checksum);
        if (duplicateId) {
          await this.jobRepository.queue({
            name: JobName.FileDelete,
            data: { files: [file.originalPath, sidecarFile?.originalPath] },
          });
          logIphoneBackupAudit(this.logger, {
            event: 'duplicate_after_receive',
            ownerId: auth.user.id,
            uploadId: file.uuid,
            mediaBytes: file.size,
            sidecarBytes: sidecarFile?.size ?? 0,
            assetId: duplicateId,
          });
          return { id: duplicateId, status: AssetMediaStatus.DUPLICATE };
        }
      } else {
        this.requireQuota(auth, file.size);
      }

      if (dto.livePhotoVideoId) {
        await onBeforeLink(
          { asset: this.assetRepository, event: this.eventRepository },
          { userId: auth.user.id, livePhotoVideoId: dto.livePhotoVideoId },
        );
      }

      const originalPath = backup ? await this.publishIphoneBackup(backup, dto, file, published) : file.originalPath;
      let sidecarPath = sidecarFile?.originalPath;
      if (backup && sidecarFile) {
        sidecarPath = `${originalPath}.xmp`;
        await this.storageRepository.publishFile(sidecarFile.originalPath, sidecarPath);
        published.push(sidecarPath);
      }

      asset = await this.assetRepository.create({
        ownerId: auth.user.id,
        libraryId: backup?.libraryId ?? null,

        checksum: backup ? this.cryptoRepository.hashSha1(`path:${originalPath}`) : file.checksum,
        checksumAlgorithm: backup ? ChecksumAlgorithm.sha1Path : ChecksumAlgorithm.sha1File,
        ...(backup && { contentChecksum: file.checksum, isExternal: true }),
        originalPath,

        fileCreatedAt: dto.fileCreatedAt,
        fileModifiedAt: dto.fileModifiedAt,
        localDateTime: dto.fileCreatedAt,

        type: mimeTypes.assetType(file.originalPath),
        isFavorite: dto.isFavorite,
        duration: dto.duration || null,
        visibility: dto.visibility ?? AssetVisibility.Timeline,
        livePhotoVideoId: dto.livePhotoVideoId,
        originalFileName: dto.filename || file.originalName,
      });

      if (dto.metadata?.length) {
        await this.assetRepository.upsertMetadata(asset.id, dto.metadata);
      }

      if (sidecarFile) {
        await this.assetRepository.upsertFile({
          assetId: asset.id,
          path: sidecarPath!,
          type: AssetFileType.Sidecar,
        });
        await this.storageRepository.utimes(sidecarPath!, new Date(), new Date(dto.fileModifiedAt));
      }
      await this.storageRepository.utimes(originalPath, new Date(), new Date(dto.fileModifiedAt));
      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: file.size },
        lockedPropertiesBehavior: 'override',
      });

      await this.jobRepository.queue({
        name: JobName.AssetExtractMetadata,
        data: { id: asset.id, source: 'upload', assetType: asset.type },
      });

      if (auth.sharedLink) {
        await this.addToSharedLink(auth.sharedLink, asset.id);
      }

      // 外部库沿用扫描导入的计费语义，不把原片计入普通上传配额。
      await this.eventRepository.emit('AssetCreate', { asset, file: backup ? undefined : file });

      if (backup) {
        await this.jobRepository.queue({
          name: JobName.FileDelete,
          data: { files: [file.originalPath, sidecarFile?.originalPath] },
        });
        logIphoneBackupAudit(this.logger, {
          event: 'external_asset_created',
          ownerId: auth.user.id,
          uploadId: file.uuid,
          mediaBytes: file.size,
          sidecarBytes: sidecarFile?.size ?? 0,
          assetId: asset.id,
          libraryId: backup.libraryId,
          overwrite: false,
        });
      }

      return { id: asset.id, status: AssetMediaStatus.CREATED };
    } catch (error: any) {
      // clean up files
      await this.jobRepository.queue({
        name: JobName.FileDelete,
        data: { files: [file.originalPath, sidecarFile?.originalPath, ...published] },
      });

      // 发布锁释放前撤销本次文件，避免后台扫描把建档失败的副本重新导入。
      for (const filename of published) {
        await this.storageRepository.unlink(filename);
      }

      // handle duplicates with a success response
      if (isAssetChecksumConstraint(error)) {
        const duplicateId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, file.checksum);
        if (!duplicateId) {
          this.logger.error(`Error locating duplicate for checksum constraint`);
          throw new InternalServerErrorException();
        }

        if (auth.sharedLink) {
          await this.addToSharedLink(auth.sharedLink, duplicateId);
        }

        this.logger.debug(`Duplicate asset upload rejected: existing asset ${duplicateId}`);
        logIphoneBackupAudit(this.logger, {
          event: 'duplicate_after_receive',
          ownerId: auth.user.id,
          uploadId: file.uuid,
          mediaBytes: file.size,
          sidecarBytes: sidecarFile?.size ?? 0,
          assetId: duplicateId,
        });
        return { status: AssetMediaStatus.DUPLICATE, id: duplicateId };
      }

      // clean up the asset row if one was created
      if (asset) {
        await this.assetRepository.remove({ id: asset.id });
      }

      logIphoneBackupAudit(this.logger, {
        event: 'upload_rolled_back',
        ownerId: auth.user.id,
        uploadId: file.uuid,
        mediaBytes: file.size,
        sidecarBytes: sidecarFile?.size ?? 0,
        assetId: asset?.id,
        publishedFilesRemoved: published.length,
      });

      this.logger.error(`Error uploading file ${error}`, error?.stack);
      throw error;
    }
  }

  /**
   * 按拍摄时间原子发布原片；同秒不同照片追加 +1 等序号，绝不覆盖已有文件。
   * @param backup 已验证的根目录、库 ID 及排除规则。
   * @param dto 手机上传时间信息和可选原始文件名。
   * @param file 服务端完整暂存的原片，仅进行读取。
   * @param published 追加本次成功发布的路径，供建档失败时安全清理。
   * @returns 最终原片路径；超过冲突上限或违反库规则时抛错。
   */
  private async publishIphoneBackup(
    backup: IphoneBackupTarget,
    dto: AssetMediaCreateDto,
    file: UploadFile,
    published: string[],
  ): Promise<string> {
    const tags = await this.metadataRepository.readTags(file.originalPath);
    const capturedAt =
      firstDateTime(tags)?.dateTime.toDateTime() ?? DateTime.fromJSDate(dto.fileCreatedAt, { zone: backup.timeZone });
    const target = getIphoneBackupPath(backup.root, capturedAt, dto.filename || file.originalName);
    if (backup.minMonth && capturedAt.toFormat('yyyyMM') < backup.minMonth) {
      throw new BadRequestException('Photo predates the configured backup start month');
    }
    let parent = backup.root;
    // 逐层检查后才创建下一层，避免 YYYY 或 MM 符号链接把后续写入带出备份根目录。
    for (const folder of path.relative(backup.root, path.dirname(target)).split(path.sep)) {
      const next = path.join(parent, folder);
      this.storageRepository.mkdirSync(next);
      parent = await this.storageRepository.realpath(next);
      if (!isWithinDirectory(backup.root, parent)) {
        throw new BadRequestException('iPhone backup destination escapes the configured root');
      }
    }

    const extension = path.extname(target);
    const base = target.slice(0, -extension.length);
    for (let index = 0; index < 1000; index++) {
      const destination = index === 0 ? target : `${base}+${index}${extension}`;
      if (backup.exclusionPatterns.some((pattern) => picomatch.isMatch(destination, pattern, { nocase: true }))) {
        throw new BadRequestException('iPhone backup destination is excluded from the library');
      }
      try {
        await this.storageRepository.publishFile(file.originalPath, destination);
        published.push(destination);
        return destination;
      } catch (error) {
        // 只对目标重名换用下一个名称；权限、空间和 I/O 错误交给请求失败处理。
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        logIphoneBackupAudit(this.logger, { event: 'filename_collision', uploadId: file.uuid, nextSuffix: index + 1 });
      }
    }
    throw new BadRequestException('Too many iPhone backup filename collisions');
  }

  async downloadOriginal(auth: AuthDto, id: string, dto: AssetDownloadOriginalDto): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: [id] });

    if (auth.sharedLink) {
      dto.edited = true;
    }

    const { originalPath, originalFileName, editedPath } = await this.assetRepository.getForOriginal(
      id,
      dto.edited ?? false,
    );

    const path = editedPath ?? originalPath!;

    return new ImmichFileResponse({
      path,
      fileName: getFileNameWithoutExtension(originalFileName) + getFilenameExtension(path),
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async viewThumbnail(
    auth: AuthDto,
    id: string,
    dto: AssetMediaOptionsDto,
  ): Promise<ImmichFileResponse | AssetMediaRedirectResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    if (dto.size === AssetMediaSize.Original) {
      throw new BadRequestException('May not request original file');
    }

    if (auth.sharedLink) {
      dto.edited = true;
    }

    const size = (dto.size ?? AssetMediaSize.THUMBNAIL) as unknown as AssetFileType;
    const { originalPath, originalFileName, path } = await this.assetRepository.getForThumbnail(
      id,
      size,
      dto.edited ?? false,
    );

    if (size === AssetFileType.FullSize && mimeTypes.isWebSupportedImage(originalPath) && !dto.edited) {
      // use original file for web supported images
      return { targetSize: 'original' };
    }

    if (dto.size === AssetMediaSize.FULLSIZE && !path) {
      // downgrade to preview if fullsize is not available.
      // e.g. disabled or not yet (re)generated
      return { targetSize: AssetMediaSize.PREVIEW };
    }

    if (!path) {
      throw new NotFoundException('Asset media not found');
    }

    const fileNameBase =
      auth.sharedLink && !auth.sharedLink.showExif ? id : getFileNameWithoutExtension(originalFileName);
    const fileName = `${fileNameBase}_${size}${getFilenameExtension(path)}`;

    return new ImmichFileResponse({
      fileName,
      path,
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async playbackVideo(auth: AuthDto, id: string): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    const asset = await this.assetRepository.getForVideo(id);

    if (!asset) {
      throw new NotFoundException('Asset not found or asset is not a video');
    }

    const filepath = asset.encodedVideoPath || asset.originalPath;

    return new ImmichFileResponse({
      path: filepath,
      contentType: mimeTypes.lookup(filepath),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  /**
   * 检查客户端提交的内容指纹，并记录预检结果；预检不代表客户端实际跳过上传。
   * @param auth 当前已鉴权用户。
   * @param dto 客户端标识和内容哈希列表，不包含照片原片。
   * @returns 每个待上传项的接受或重复结果，保持既有响应结构。
   */
  async bulkUploadCheck(auth: AuthDto, dto: AssetBulkUploadCheckDto): Promise<AssetBulkUploadCheckResponseDto> {
    const checksums: Buffer[] = dto.assets.map((asset) => fromChecksum(asset.checksum));
    const results = await this.assetRepository.getByChecksums(auth.user.id, checksums);
    const checksumMap: Record<string, { id: string; isTrashed: boolean }> = {};

    for (const { id, deletedAt, checksum } of results) {
      checksumMap[checksum.toString('hex')] = { id, isTrashed: !!deletedAt };
    }

    const response = {
      results: dto.assets.map(({ id, checksum }) => {
        const duplicate = checksumMap[fromChecksum(checksum).toString('hex')];
        if (duplicate) {
          return {
            id,
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            assetId: duplicate.id,
            isTrashed: duplicate.isTrashed,
          };
        }

        return {
          id,
          action: AssetUploadAction.ACCEPT,
        };
      }),
    };
    logIphoneBackupAudit(this.logger, {
      event: 'upload_precheck',
      ownerId: auth.user.id,
      checked: dto.assets.length,
      duplicates: response.results.filter(({ action }) => action === AssetUploadAction.REJECT).length,
    });
    return response;
  }

  private async addToSharedLink(sharedLink: AuthSharedLink, assetId: string) {
    if (!sharedLink.albumId) {
      await this.sharedLinkRepository.addAssets(sharedLink.id, [assetId]);
      return;
    }

    const album = await this.albumRepository.getById(sharedLink.albumId, { withAssets: false });
    if (!album) {
      return;
    }

    await this.albumRepository.addAssetIds(album.id, [assetId]);
    const userIds = album.albumUsers.map(({ user }) => user.id);
    await this.eventRepository.emit('AlbumUpdate', {
      id: album.id,
      userIds,
      recipientIds: userIds,
    });
  }

  private requireQuota(auth: AuthDto, size: number) {
    if (auth.user.quotaSizeInBytes !== null && auth.user.quotaSizeInBytes < auth.user.quotaUsageInBytes + size) {
      throw new BadRequestException('Quota has been exceeded!');
    }
  }
}
