import { BadRequestException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { R_OK } from 'node:constants';
import { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path, { isAbsolute, parse } from 'node:path';
import picomatch from 'picomatch';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { JOBS_LIBRARY_PAGINATION_SIZE } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  CreateLibraryDto,
  LibraryResponseDto,
  LibraryStatsResponseDto,
  UpdateLibraryDto,
  ValidateLibraryDto,
  ValidateLibraryImportPathResponseDto,
  ValidateLibraryResponseDto,
  mapLibrary,
} from 'src/dtos/library.dto.js';
import {
  AssetStatus,
  AssetType,
  ChecksumAlgorithm,
  CronJob,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
} from 'src/enum.js';
import { AssetSyncResult } from 'src/repositories/library.repository.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import {
  getIphoneBackupConfig,
  isIphoneBackupFingerprintingEnabled,
  isWithinDirectory,
  logIphoneBackupAudit,
} from 'src/utils/iphone-backup.js';
import { isMissingLibraryPath, watchLibraryDirectories } from 'src/utils/library-directory-watch.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { batched, findOrFail, handlePromiseError } from 'src/utils/misc.js';

const DEFERRED_VIDEO_SIZE_BYTES = 3 * 1024 ** 3;
const DIRECTORY_WATCH_BATCH_SIZE = 128;

@Injectable()
/** 管理外部库扫描与状态更新；目标备份库的导入与上传发布使用同一数据库锁。 */
export class LibraryService extends BaseService {
  private watchLibraries = false;
  private lock = false;
  private watchers: Record<string, () => Promise<void>> = {};
  private readonly directoryWatchRoot = process.env.IMMICH_FORK_LIBRARY_WATCH_ROOT;
  private directoryWatchRevision = 0;

  /** 初始化图库 cron 和监听。目录试点沿用外部图库主工作进程的数据库锁。 */
  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({
    newConfig: {
      library: { watch, scan },
    },
  }: ArgOf<'ConfigInit'>) {
    // This ensures that library watching only occurs in one microservice
    this.lock = await this.databaseRepository.tryLock(DatabaseLock.Library);

    this.watchLibraries = this.lock && watch.enabled;

    if (this.lock) {
      this.cronRepository.create({
        name: CronJob.LibraryScan,
        expression: scan.cronExpression,
        onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.LibraryScanQueueAll }), this.logger),
        start: scan.enabled,
      });
    }

    if (this.watchLibraries) {
      await this.watchAll();
    } else if (this.directoryWatchRoot) {
      await this.refreshDirectoryWatch();
    }
  }

  /** 只监听配置路径明确归属的库，任务消费时重新检查当前导入路径和排除规则。 */
  private async refreshDirectoryWatch() {
    const root = this.directoryWatchRoot;
    if (!this.lock || !root || this.watchLibraries) {
      return;
    }
    const revision = ++this.directoryWatchRevision;
    await this.unwatchAll();
    const allLibraries = await this.libraryRepository.getAll(false);
    const libraries = allLibraries.filter((library) =>
      this.isDirectoryWatchPath(library, root, root),
    );
    if (libraries.length !== 1) {
      this.logger.warn('Library directory watch requires exactly one matching external library');
      return;
    }
    const [library] = libraries;
    try {
      const stats = await lstat(root);
      if (!stats.isDirectory() || (await realpath(root)) !== root) {
        throw new Error('Library directory watch root must be a canonical directory');
      }
      const watched = await watchLibraryDirectories(
        root,
        library.exclusionPatterns,
        /** 将事件批次交给现有图库队列，暂停时仍保留任务。 */
        (changes) =>
          this.jobRepository.queue({
            name: JobName.LibrarySyncFiles,
            data: {
              libraryId: library.id,
              paths: changes.paths,
              directoryWatch: { root, directories: changes.directories },
            },
          }),
        (error) => this.logger.error(`Library directory watch failed: ${error}`),
      );
      if (this.watchLibraries || revision !== this.directoryWatchRevision) {
        watched.close();
        return;
      }
      this.watchers[library.id] = () => {
        watched.close();
        return Promise.resolve();
      };
      this.logger.log(`Library directory watch ready: ${watched.count} directories`);
      // 先开始接收事件，再补查停机期间的变化，避免在初次扫描和监听之间遗漏文件。
      await this.jobRepository.queue({
        name: JobName.LibrarySyncFiles,
        data: { libraryId: library.id, paths: [], directoryWatch: { root, directories: [root] } },
      });
    } catch (error) {
      this.logger.error(`Library directory watch failed to start: ${error}`);
    }
  }

  /** 更新图库 cron；切换普通监听时重建监听范围。 */
  @OnEvent({ name: 'ConfigUpdate', server: true })
  async onConfigUpdate({ newConfig: { library } }: ArgOf<'ConfigUpdate'>) {
    if (!this.lock) {
      return;
    }

    this.cronRepository.update({
      name: CronJob.LibraryScan,
      expression: library.scan.cronExpression,
      start: library.scan.enabled,
    });

    if (library.watch.enabled === this.watchLibraries) {
      return;
    }

    // Watch configuration changed, update accordingly
    this.watchLibraries = library.watch.enabled;
    this.directoryWatchRevision++;
    await this.unwatchAll();
    await (this.watchLibraries ? this.watchAll() : this.refreshDirectoryWatch());
  }

  private async watch(id: string): Promise<boolean> {
    if (!this.watchLibraries) {
      return false;
    }

    const library = await this.findOrFail(id);
    if (library.importPaths.length === 0) {
      return false;
    }

    await this.unwatch(id);

    this.logger.log(`Starting to watch library ${library.id} with import path(s) ${library.importPaths}`);

    const matcher = picomatch(`**/*{${mimeTypes.getSupportedFileExtensions().join(',')}}`, {
      nocase: true,
      ignore: library.exclusionPatterns,
    });

    let _resolve: () => void;
    const ready$ = new Promise<void>((resolve) => (_resolve = resolve));

    const handler = async (event: string, path: string) => {
      if (matcher(path)) {
        this.logger.debug(`File ${event} event received for ${path} in library ${library.id}`);
        await this.jobRepository.queue({
          name: JobName.LibrarySyncFiles,
          data: { libraryId: library.id, paths: [path] },
        });
      } else {
        this.logger.verbose(`Ignoring file ${event} event for ${path} in library ${library.id}`);
      }
    };

    const deletionHandler = async (path: string) => {
      this.logger.debug(`File unlink event received for ${path} in library ${library.id}`);
      await this.jobRepository.queue({
        name: JobName.LibraryRemoveAsset,
        data: { libraryId: library.id, paths: [path] },
      });
    };

    this.watchers[id] = this.storageRepository.watch(
      library.importPaths,
      {
        usePolling: false,
        ignoreInitial: true,
        ignored: library.exclusionPatterns,
        awaitWriteFinish: {
          stabilityThreshold: 5000,
          pollInterval: 1000,
        },
      },
      {
        onReady: () => _resolve(),
        onAdd: (path) => {
          return handlePromiseError(handler('add', path), this.logger);
        },
        onChange: (path) => {
          return handlePromiseError(handler('change', path), this.logger);
        },
        onUnlink: (path) => {
          return handlePromiseError(deletionHandler(path), this.logger);
        },
        onError: (error) => {
          this.logger.error(`Library watcher for library ${library.id} encountered error: ${error}`);
        },
      },
    );

    // Wait for the watcher to initialize before returning
    await ready$;

    return true;
  }

  async unwatch(id: string) {
    if (!Object.hasOwn(this.watchers, id)) {
      return;
    }

    await this.watchers[id]();
    delete this.watchers[id];
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.directoryWatchRevision++;
    await this.unwatchAll();
  }

  private async unwatchAll() {
    if (!this.lock) {
      return false;
    }

    for (const id in this.watchers) {
      await this.unwatch(id);
    }
  }

  async watchAll() {
    if (!this.lock) {
      return false;
    }

    const libraries = await this.libraryRepository.getAll(false);
    for (const library of libraries) {
      await this.watch(library.id);
    }
  }

  async getStatistics(id: string): Promise<LibraryStatsResponseDto> {
    const statistics = await this.libraryRepository.getStatistics(id);
    if (!statistics) {
      throw new BadRequestException(`Library ${id} not found`);
    }
    return statistics;
  }

  async get(id: string): Promise<LibraryResponseDto> {
    const library = await this.findOrFail(id);
    return mapLibrary(library);
  }

  async getAll(): Promise<LibraryResponseDto[]> {
    const libraries = await this.libraryRepository.getAll(false);
    return libraries.map((library) => mapLibrary(library));
  }

  @OnJob({ name: JobName.LibraryDeleteCheck, queue: QueueName.Library })
  async handleQueueCleanup(): Promise<JobStatus> {
    this.logger.log('Checking for any libraries pending deletion...');
    const pendingDeletions = await this.libraryRepository.getAllDeleted();
    if (pendingDeletions.length > 0) {
      const libraryString = pendingDeletions.length === 1 ? 'library' : 'libraries';
      this.logger.log(`Found ${pendingDeletions.length} ${libraryString} pending deletion, cleaning up...`);

      await this.jobRepository.queueAll(
        pendingDeletions.map((libraryToDelete) => ({ name: JobName.LibraryDelete, data: { id: libraryToDelete.id } })),
      );
    }

    return JobStatus.Success;
  }

  async create(dto: CreateLibraryDto): Promise<LibraryResponseDto> {
    const library = await this.libraryRepository.create({
      ownerId: dto.ownerId,
      name: dto.name ?? 'New External Library',
      importPaths: dto.importPaths ?? [],
      exclusionPatterns: dto.exclusionPatterns ?? [
        '**/@eaDir/**',
        '**/._*',
        '**/#recycle/**',
        '**/#snapshot/**',
        '**/.stversions/**',
        '**/.stfolder/**',
      ],
    });
    return mapLibrary(library);
  }

  @OnJob({ name: JobName.LibrarySyncFiles, queue: QueueName.Library })
  /**
   * 导入扫描发现的文件；目标备份库与上传串行建档，避免发布文件被重复扫描成第二条资产。
   * @param job 待导入路径及所属 Library ID。
   * @returns 导入状态；失败沿用已有任务重试机制。
   */
  async handleSyncFiles(job: JobOf<JobName.LibrarySyncFiles>): Promise<JobStatus> {
    if (job.directoryWatch) {
      const scope = job.directoryWatch;
      // 与手机上传、指纹准备和源资产状态更新共用锁；锁内调用原有导入实现，避免重复取锁。
      return getIphoneBackupConfig()?.libraryId === job.libraryId
        ? this.databaseRepository.withLock(DatabaseLock.ForkIphoneBackup, () => this.syncDirectoryWatch(job, scope))
        : this.syncDirectoryWatch(job, scope);
    }
    if (getIphoneBackupConfig()?.libraryId === job.libraryId) {
      return this.databaseRepository.withLock(DatabaseLock.ForkIphoneBackup, () => this.importFiles(job));
    }
    return this.importFiles(job);
  }

  /**
  限制增量任务只处理当前导入范围内的试点路径，使用与扫描一致的图库排除规则。
  @param library 当前图库配置。
  @param root 试点根目录。
  @param candidate 待核对的路径。
  @returns 路径位于根和导入范围内，且没有隐藏或被排除的组件时为 true。
  */
  private isDirectoryWatchPath(
    library: { importPaths: string[]; exclusionPatterns: string[] },
    root: string,
    candidate: string,
  ): boolean {
    if (!path.isAbsolute(root) || !isWithinDirectory(root, candidate)) {
      return false;
    }
    const importRoot = library.importPaths.find((entry) => isWithinDirectory(entry, root));
    if (!importRoot) {
      return false;
    }
    const excluded = picomatch(library.exclusionPatterns, { nocase: true, dot: true });
    let current = candidate;
    while (current !== importRoot && current !== path.dirname(current)) {
      if (path.basename(current).startsWith('.') || excluded(current) || excluded(current + '/')) {
        return false;
      }
      current = path.dirname(current);
    }
    return true;
  }

  /**
  核对队列任务中的文件和子树，复用已有资产检查与入库流程。
  @param job 含文件路径的图库任务。
  @param scope 试点根目录及需要扫描的子树。
  @returns 根目录失效时跳过，数据库或磁盘错误交由任务日志记录。
  */
  private async syncDirectoryWatch(
    job: JobOf<JobName.LibrarySyncFiles>,
    scope: NonNullable<JobOf<JobName.LibrarySyncFiles>['directoryWatch']>,
  ): Promise<JobStatus> {
    const { root, directories } = scope;
    const library = await this.libraryRepository.get(job.libraryId);
    if (root !== this.directoryWatchRoot || !library || !this.isDirectoryWatchPath(library, root, root)) {
      return JobStatus.Skipped;
    }
    // 根目录本身缺失或被替换为链接时，不能把整个图库中的资产判为离线。
    const rootStats = await this.getDirectoryWatchStat(root);
    if (!rootStats?.isDirectory()) {
      this.logger.warn('Library directory watch root is unavailable');
      return JobStatus.Skipped;
    }

    const paths = [...new Set(job.paths)].filter(
      (candidate) => mimeTypes.isAsset(candidate) && this.isDirectoryWatchPath(library, root, candidate),
    );
    for (let offset = 0; offset < paths.length; offset += DIRECTORY_WATCH_BATCH_SIZE) {
      await this.syncDirectoryWatchPaths(library, paths.slice(offset, offset + DIRECTORY_WATCH_BATCH_SIZE));
    }

    for (const directory of new Set(directories)) {
      if (!this.isDirectoryWatchPath(library, root, directory)) {
        continue;
      }
      const stats = await this.getDirectoryWatchStat(directory);
      if (stats?.isDirectory()) {
        for await (const batch of this.storageRepository.walk({
          pathsToCrawl: [directory],
          includeHidden: false,
          exclusionPatterns: library.exclusionPatterns,
          take: DIRECTORY_WATCH_BATCH_SIZE,
          followSymbolicLinks: false,
        })) {
          await this.syncDirectoryWatchPaths(library, batch, false);
        }
      }
      // 子树已移出，或路径未知事件需要核对其已有资产。保持已有离线和恢复语义。
      const assets = await this.libraryRepository.getAssetIdsForDirectoryWatch(library.id, [], directory);
      for (let offset = 0; offset < assets.length; offset += DIRECTORY_WATCH_BATCH_SIZE) {
        await this.checkDirectoryWatchAssets(library, assets.slice(offset, offset + DIRECTORY_WATCH_BATCH_SIZE));
      }
    }
    return JobStatus.Success;
  }

  /**
  路径批次按既有资产和新文件分别交给原有处理流程。
  @param library 当前库的 ID、导入路径及排除规则。
  @param paths 已限定在监听范围的文件路径。
  @param refreshExisting 明确收到变化事件时刷新原有资产；子树扫描统一在随后复查。
  */
  private async syncDirectoryWatchPaths(
    library: { id: string; importPaths: string[]; exclusionPatterns: string[] },
    paths: string[],
    refreshExisting = true,
  ) {
    if (refreshExisting) {
      const assets = await this.libraryRepository.getAssetIdsForDirectoryWatch(library.id, paths);
      await this.checkDirectoryWatchAssets(library, assets, true);
    }
    const candidates = await this.assetRepository.filterNewExternalAssetPaths(library.id, paths);
    const fresh: string[] = [];
    for (const candidate of candidates) {
      const stats = await this.getDirectoryWatchStat(candidate);
      if (stats?.isFile()) {
        fresh.push(candidate);
      }
    }
    if (fresh.length > 0) {
      await this.importFiles({ libraryId: library.id, paths: fresh });
    }
  }

  /**
  将已有资产交给正常外部库同步逻辑，已有 ID 和回收站状态由原流程维护。
  @param library 当前图库及其规则。
  @param assets 需要复查的资产 ID。
  @param forceRefresh 来自明确的文件事件时强制刷新。
  */
  private async checkDirectoryWatchAssets(
    library: { id: string; importPaths: string[]; exclusionPatterns: string[] },
    assets: { id: string }[],
    forceRefresh = false,
  ) {
    if (assets.length > 0) {
      await this.handleSyncAssets({
        libraryId: library.id,
        importPaths: library.importPaths,
        exclusionPatterns: library.exclusionPatterns,
        assetIds: assets.map(({ id }) => id),
        progressCounter: assets.length,
        totalAssets: assets.length,
        fromDirectoryWatch: true,
        forceRefresh,
      });
    }
  }

  /**
  仅将真正缺失的路径视为离线候选，并拒绝经符号链接解析到其他位置的文件。
  @param candidate 试点中的绝对路径。
  @returns 文件状态；不存在时返回 null，权限错误和非规范路径抛错。
  */
  private async getDirectoryWatchStat(candidate: string): Promise<Stats | null> {
    try {
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink() || (await realpath(candidate)) !== candidate) {
        throw new Error('Library directory watch found a symbolic link');
      }
      return stats;
    } catch (error) {
      if (isMissingLibraryPath(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * 在调用者已经取得必要锁后执行原有文件导入。
   * @param job 扫描批次，不修改其路径列表。
   * @returns 原有导入结果；同路径重复任务由既有 checksum 唯一约束忽略。
   */
  private async importFiles(job: JobOf<JobName.LibrarySyncFiles>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.libraryId);
    // We need to check if the library still exists as it could have been deleted after the scan was queued
    if (!library) {
      this.logger.debug(`Library ${job.libraryId} not found, skipping file import`);
      return JobStatus.Failed;
    }
    if (library.deletedAt) {
      this.logger.debug(`Library ${job.libraryId} is deleted, won't import assets into it`);
      return JobStatus.Failed;
    }

    const assetImports: Insertable<AssetTable>[] = [];
    let deferredCount = 0;
    await Promise.all(
      job.paths.map(async (path) => {
        try {
          const asset = await this.processEntity(path, library.ownerId, job.libraryId);
          if (asset) {
            if (getIphoneBackupConfig()?.libraryId === job.libraryId) {
              const existing = await this.assetRepository.getByLibraryIdAndOriginalPath(
                job.libraryId,
                asset.originalPath,
              );
              if (existing) {
                // 文件监听同样会发现既有路径；更新内容映射而不创建第二个资产。
                if (asset.contentChecksum && !existing.contentChecksum?.equals(asset.contentChecksum)) {
                  await this.assetRepository.update({ id: existing.id, contentChecksum: asset.contentChecksum });
                  await this.jobRepository.queue({
                    name: JobName.AssetExtractMetadata,
                    data: { id: existing.id, force: true },
                  });
                }
                return;
              }
            }
            assetImports.push(asset);
          } else {
            deferredCount++;
          }
        } catch (error) {
          this.logger.error(`Error processing ${path} for library ${job.libraryId}: ${error}`);
          if (getIphoneBackupConfig()?.libraryId === job.libraryId) {
            const existing = await this.assetRepository.getByLibraryIdAndOriginalPath(job.libraryId, path);
            if (existing?.contentChecksum) {
              await this.assetRepository.update({ id: existing.id, contentChecksum: null });
            }
            // 不能用忽略指纹错误来完成首轮备份准备；保持任务失败并允许重试。
            throw error;
          }
        }
      }),
    );

    if (deferredCount > 0) {
      this.logger.log(`Deferred ${deferredCount} heavy video file(s) from library ${job.libraryId}`);
    }

    const assetIds = await this.assetRepository.createAll(assetImports);
    if (isIphoneBackupFingerprintingEnabled(job.libraryId)) {
      for (const assetId of assetIds) {
        logIphoneBackupAudit(this.logger, { event: 'fingerprint_ready', assetId, libraryId: job.libraryId });
      }
    }

    const progressMessage =
      job.progressCounter && job.totalAssets
        ? `(${job.progressCounter} of ${job.totalAssets})`
        : `(${job.progressCounter} done so far)`;

    this.logger.log(`Imported ${assetIds.length} ${progressMessage} file(s) into library ${job.libraryId}`);

    await Promise.all(
      assetIds.map((assetId) =>
        this.eventRepository.emit('AssetCreate', { asset: { id: assetId, ownerId: library.ownerId } }),
      ),
    );

    await this.queuePostSyncJobs(assetIds);

    return JobStatus.Success;
  }

  private async validateImportPath(importPath: string): Promise<ValidateLibraryImportPathResponseDto> {
    const validation = new ValidateLibraryImportPathResponseDto();
    validation.importPath = importPath;
    validation.isValid = false;

    if (StorageCore.isImmichPath(importPath)) {
      validation.message = 'Cannot use media upload folder for external libraries';
      return validation;
    }

    if (!isAbsolute(importPath)) {
      validation.message = `Import path must be absolute, try ${path.resolve(importPath)}`;
      return validation;
    }

    try {
      const stat = await this.storageRepository.stat(importPath);
      if (!stat.isDirectory()) {
        validation.message = 'Not a directory';
        return validation;
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        validation.message = 'Path does not exist (ENOENT)';
        return validation;
      }
      validation.message = String(error);
      return validation;
    }

    const isAccess = await this.storageRepository.checkFileExists(importPath, R_OK);

    if (!isAccess) {
      validation.message = 'Lacking read permission for folder';
      return validation;
    }

    validation.isValid = true;
    return validation;
  }

  async validate(id: string, dto: ValidateLibraryDto): Promise<ValidateLibraryResponseDto> {
    const importPaths = await Promise.all(
      (dto.importPaths || []).map((importPath) => this.validateImportPath(importPath)),
    );
    return { importPaths };
  }

  async update(id: string, dto: UpdateLibraryDto): Promise<LibraryResponseDto> {
    await this.findOrFail(id);

    if (dto.importPaths) {
      const validation = await this.validate(id, { importPaths: dto.importPaths });
      if (validation.importPaths) {
        for (const path of validation.importPaths) {
          if (!path.isValid) {
            throw new BadRequestException(`Invalid import path: ${path.message}`);
          }
        }
      }
    }

    const library = await this.libraryRepository.update(id, dto);
    return mapLibrary(library);
  }

  async delete(id: string) {
    await this.findOrFail(id);

    if (this.watchLibraries) {
      await this.unwatch(id);
    }

    await this.libraryRepository.softDelete(id);
    await this.jobRepository.queue({ name: JobName.LibraryDelete, data: { id } });
  }

  @OnJob({ name: JobName.LibraryDelete, queue: QueueName.Library })
  async handleDeleteLibrary(job: JobOf<JobName.LibraryDelete>): Promise<JobStatus> {
    const libraryId = job.id;

    await this.assetRepository.updateByLibraryId(libraryId, { deletedAt: new Date() });

    this.logger.debug(`Will delete all assets in library ${libraryId}`);
    let hasAssets = false;
    for await (const assets of batched(
      this.libraryRepository.streamAssetIds(libraryId),
      JOBS_LIBRARY_PAGINATION_SIZE,
    )) {
      this.logger.debug(`Queueing deletion of ${assets.length} asset(s) in library ${libraryId}`);
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetDelete, data: { id: asset.id, deleteOnDisk: false } })),
      );
      hasAssets = true;
    }

    if (!hasAssets) {
      this.logger.log(`Deleting library ${libraryId}`);
      await this.libraryRepository.delete(libraryId);
    }

    return JobStatus.Success;
  }

  /**
   * 读取外部文件属性；只为指定备份库增加内容指纹，路径身份保持不变。
   * @param filePath 扫描获得的原片绝对路径。
   * @param ownerId 所属用户 UUID。
   * @param libraryId 当前扫描库 UUID。
   * @returns 新资产字段；现有策略延后处理的文件返回 undefined。
   */
  private async processEntity(filePath: string, ownerId: string, libraryId: string) {
    const assetPath = path.normalize(filePath);
    // Keep these files discoverable on later scans, but avoid creating assets that would enqueue heavy processing.
    if (path.extname(assetPath).toLowerCase() === '.insv') {
      return;
    }

    const stat = await this.storageRepository.stat(assetPath);
    if (mimeTypes.isVideo(assetPath) && stat.size > DEFERRED_VIDEO_SIZE_BYTES) {
      return;
    }

    return {
      ownerId,
      libraryId,
      checksum: this.cryptoRepository.hashSha1(`path:${assetPath}`),
      contentChecksum: isIphoneBackupFingerprintingEnabled(libraryId)
        ? await this.readContentChecksum(assetPath, stat)
        : null,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      originalPath: assetPath,

      fileCreatedAt: stat.mtime,
      fileModifiedAt: stat.mtime,
      localDateTime: stat.mtime,
      type: mimeTypes.isVideo(assetPath) ? AssetType.Video : AssetType.Image,
      originalFileName: parse(assetPath).base,
      isExternal: true,
      livePhotoVideoId: null,
    };
  }

  /**
   * 流式计算内容 SHA-1，并确认读取期间文件大小和修改时间未变。
   * @param filePath 外部原片路径，仅进行读取。
   * @param before 哈希前的文件状态。
   * @returns 稳定文件的内容指纹；文件变化或读取失败时抛错，不发布可疑指纹。
   */
  private async readContentChecksum(filePath: string, before: Stats): Promise<Buffer> {
    const checksum = await this.cryptoRepository.hashFile(filePath);
    const after = await this.storageRepository.stat(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('External file changed while hashing');
    }
    return checksum;
  }

  async queuePostSyncJobs(assetIds: string[]) {
    this.logger.debug(`Queuing sidecar discovery for ${assetIds.length} asset(s)`);

    // We queue a sidecar discovery which, in turn, queues metadata extraction
    await this.jobRepository.queueAll(
      assetIds.map((assetId) => ({
        name: JobName.SidecarCheck,
        data: { id: assetId, source: 'upload' },
      })),
    );
  }

  async queueScan(id: string) {
    await this.findOrFail(id);

    this.logger.log(`Starting to scan library ${id}`);

    await this.jobRepository.queue({
      name: JobName.LibrarySyncFilesQueueAll,
      data: {
        id,
      },
    });

    await this.jobRepository.queue({ name: JobName.LibrarySyncAssetsQueueAll, data: { id } });
  }

  @OnJob({ name: JobName.LibraryScanQueueAll, queue: QueueName.Library })
  async handleQueueScanAll(): Promise<JobStatus> {
    this.logger.log(`Initiating scan of all external libraries...`);

    await this.jobRepository.queue({ name: JobName.LibraryDeleteCheck, data: {} });

    const libraries = await this.libraryRepository.getAll(true);

    await this.jobRepository.queueAll(
      libraries.map((library) => ({
        name: JobName.LibrarySyncFilesQueueAll,
        data: {
          id: library.id,
        },
      })),
    );
    await this.jobRepository.queueAll(
      libraries.map((library) => ({
        name: JobName.LibrarySyncAssetsQueueAll,
        data: {
          id: library.id,
        },
      })),
    );

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.LibrarySyncAssets, queue: QueueName.Library })
  /**
   * 检查既有资产状态，并在显式扫描目标库时补齐或更新内容指纹。
   * @param job 库扫描批次，包含导入范围和排除规则。
   * @returns 扫描结果；指纹读取失败时任务失败，不能保留旧指纹假装成功。
   */
  async handleSyncAssets(job: JobOf<JobName.LibrarySyncAssets>): Promise<JobStatus> {
    const assets = await this.assetJobRepository.getForSyncAssets(job.assetIds);

    const assetIdsToOffline: string[] = [];
    const trashedAssetIdsToOffline: string[] = [];
    const assetIdsToOnline: string[] = [];
    const trashedAssetIdsToOnline: string[] = [];
    const assetIdsToUpdate: string[] = [];

    this.logger.debug(`Checking batch of ${assets.length} existing asset(s) in library ${job.libraryId}`);

    const stats = await Promise.all(
      assets.map((asset) =>
        job.fromDirectoryWatch
          ? this.getDirectoryWatchStat(asset.originalPath)
          : this.storageRepository.stat(asset.originalPath).catch(() => null),
      ),
    );

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const stat = stats[i];
      const action = this.checkExistingAsset(asset, stat, job.forceRefresh);
      if (
        !isIphoneBackupFingerprintingEnabled(job.libraryId) &&
        asset.contentChecksum &&
        (!stat || action === AssetSyncResult.UPDATE)
      ) {
        // 停用备份路由后仍撤销变化文件的旧指纹，不能让客户端继续匹配过期内容。
        await this.assetRepository.update({ id: asset.id, contentChecksum: null });
      }
      if (isIphoneBackupFingerprintingEnabled(job.libraryId)) {
        const accessible =
          stat &&
          asset.status !== AssetStatus.Deleted &&
          job.importPaths.some((root) => isWithinDirectory(root, asset.originalPath)) &&
          job.exclusionPatterns.every((pattern) => !picomatch.isMatch(asset.originalPath, pattern, { nocase: true }));
        if (!accessible) {
          if (asset.contentChecksum) {
            await this.assetRepository.update({ id: asset.id, contentChecksum: null });
          }
        } else if (!asset.contentChecksum || action === AssetSyncResult.UPDATE) {
          // 先撤销可能失效的匹配，再顺序读取，避免一次对整批原片发起并行磁盘扫描。
          await this.assetRepository.update({ id: asset.id, contentChecksum: null });
          const contentChecksum = await this.readContentChecksum(asset.originalPath, stat);
          await this.assetRepository.update({ id: asset.id, contentChecksum });
          logIphoneBackupAudit(this.logger, {
            event: 'fingerprint_ready',
            assetId: asset.id,
            libraryId: job.libraryId,
          });
        }
      }
      switch (action) {
        case AssetSyncResult.DO_NOTHING: {
          break;
        }
        case AssetSyncResult.OFFLINE: {
          if (asset.status === AssetStatus.Trashed) {
            trashedAssetIdsToOffline.push(asset.id);
          } else {
            assetIdsToOffline.push(asset.id);
          }
          break;
        }
        case AssetSyncResult.UPDATE: {
          assetIdsToUpdate.push(asset.id);
          break;
        }
        case AssetSyncResult.CHECK_OFFLINE: {
          const isInImportPath = job.importPaths.some((path) => asset.originalPath.startsWith(path));

          if (!isInImportPath) {
            this.logger.verbose(
              `Offline asset ${asset.originalPath} is still not in any import path, keeping offline in library ${job.libraryId}`,
            );
            break;
          }

          const isExcluded = job.exclusionPatterns.some((pattern) =>
            picomatch.isMatch(asset.originalPath, pattern, { nocase: true }),
          );

          if (!isExcluded) {
            this.logger.debug(`Offline asset ${asset.originalPath} is now online in library ${job.libraryId}`);
            if (asset.status === AssetStatus.Trashed) {
              trashedAssetIdsToOnline.push(asset.id);
            } else {
              assetIdsToOnline.push(asset.id);
              if (job.fromDirectoryWatch) {
                assetIdsToUpdate.push(asset.id);
              }
            }
            break;
          }

          this.logger.verbose(
            `Offline asset ${asset.originalPath} is in an import path but still covered by exclusion pattern, keeping offline in library ${job.libraryId}`,
          );

          break;
        }
      }
    }

    const promises = [];
    if (assetIdsToOffline.length > 0) {
      promises.push(this.assetRepository.updateAll(assetIdsToOffline, { isOffline: true, deletedAt: new Date() }));
    }

    if (trashedAssetIdsToOffline.length > 0) {
      promises.push(this.assetRepository.updateAll(trashedAssetIdsToOffline, { isOffline: true }));
    }

    if (assetIdsToOnline.length > 0) {
      promises.push(this.assetRepository.updateAll(assetIdsToOnline, { isOffline: false, deletedAt: null }));
    }

    if (trashedAssetIdsToOnline.length > 0) {
      promises.push(this.assetRepository.updateAll(trashedAssetIdsToOnline, { isOffline: false }));
    }

    if (assetIdsToUpdate.length > 0) {
      promises.push(this.queuePostSyncJobs(assetIdsToUpdate));
    }

    await Promise.all(promises);

    const remainingCount = assets.length - assetIdsToOffline.length - assetIdsToUpdate.length - assetIdsToOnline.length;
    const cumulativePercentage = ((100 * job.progressCounter) / job.totalAssets).toFixed(1);
    this.logger.log(
      `Checked existing asset(s): ${assetIdsToOffline.length + trashedAssetIdsToOffline.length} offlined, ${assetIdsToOnline.length + trashedAssetIdsToOnline.length} onlined, ${assetIdsToUpdate.length} updated, ${remainingCount} unchanged of current batch of ${assets.length} (Total progress: ${job.progressCounter} of ${job.totalAssets}, ${cumulativePercentage} %) in library ${job.libraryId}.`,
    );

    return JobStatus.Success;
  }

  /**
  根据磁盘状态决定已有资产的变更，保留回收站和恢复状态。
  @param asset 已有资产的同步字段。
  @param stat 当前文件状态；缺失时为空。
  @param forceRefresh 文件事件指明内容变化，即使 mtime 相同也刷新。
  @returns 由批次调用者执行的状态更新。
  */
  private checkExistingAsset(
    asset: {
      isOffline: boolean;
      libraryId: string | null;
      originalPath: string;
      status: AssetStatus;
      fileModifiedAt: Date;
    },
    stat: Stats | null,
    forceRefresh = false,
  ): AssetSyncResult {
    if (!stat) {
      // File not found on disk or permission error
      if (asset.isOffline) {
        this.logger.verbose(
          `Asset ${asset.originalPath} is still not accessible, keeping offline in library ${asset.libraryId}`,
        );
        return AssetSyncResult.DO_NOTHING;
      }

      this.logger.debug(
        `Asset ${asset.originalPath} is no longer on disk or is inaccessible because of permissions, marking offline in library ${asset.libraryId}`,
      );
      return AssetSyncResult.OFFLINE;
    }

    if (asset.isOffline && asset.status !== AssetStatus.Deleted) {
      // Only perform the expensive check if the asset is offline
      return AssetSyncResult.CHECK_OFFLINE;
    }

    if (forceRefresh || stat.mtime.valueOf() !== asset.fileModifiedAt.valueOf()) {
      this.logger.verbose(`Asset ${asset.originalPath} needs metadata extraction in library ${asset.libraryId}`);

      return AssetSyncResult.UPDATE;
    }

    return AssetSyncResult.DO_NOTHING;
  }

  @OnJob({ name: JobName.LibrarySyncFilesQueueAll, queue: QueueName.Library })
  async handleQueueSyncFiles(job: JobOf<JobName.LibrarySyncFilesQueueAll>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.id);
    if (!library) {
      this.logger.debug(`Library ${job.id} not found, skipping refresh`);
      return JobStatus.Skipped;
    }

    this.logger.debug(`Validating import paths for library ${library.id}...`);

    const validImportPaths: string[] = [];

    for (const importPath of library.importPaths) {
      const validation = await this.validateImportPath(importPath);
      if (validation.isValid) {
        validImportPaths.push(path.normalize(importPath));
      } else {
        this.logger.warn(`Skipping invalid import path: ${importPath}. Reason: ${validation.message}`);
      }
    }

    if (validImportPaths.length === 0) {
      this.logger.warn(`No valid import paths found for library ${library.id}`);

      return JobStatus.Skipped;
    }

    const pathsOnDisk = this.storageRepository.walk({
      pathsToCrawl: validImportPaths,
      includeHidden: false,
      exclusionPatterns: library.exclusionPatterns,
      take: JOBS_LIBRARY_PAGINATION_SIZE,
    });

    let importCount = 0;
    let crawlCount = 0;

    this.logger.log(`Starting disk crawl of ${validImportPaths.length} import path(s) for library ${library.id}...`);

    for await (const pathBatch of pathsOnDisk) {
      crawlCount += pathBatch.length;
      const paths = await this.assetRepository.filterNewExternalAssetPaths(library.id, pathBatch);

      if (paths.length > 0) {
        importCount += paths.length;

        await this.jobRepository.queue({
          name: JobName.LibrarySyncFiles,
          data: {
            libraryId: library.id,
            paths,
            progressCounter: crawlCount,
          },
        });
      }

      this.logger.log(
        `Crawled ${crawlCount} file(s) so far: ${paths.length} of current batch of ${pathBatch.length} will be imported to library ${library.id}...`,
      );
    }

    this.logger.log(
      `Finished disk crawl, ${crawlCount} file(s) found on disk and queued ${importCount} file(s) for import into ${library.id}`,
    );

    await this.libraryRepository.update(job.id, { refreshedAt: new Date() });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.LibraryRemoveAsset, queue: QueueName.Library })
  async handleAssetRemoval(job: JobOf<JobName.LibraryRemoveAsset>): Promise<JobStatus> {
    // This is only for handling file unlink events via the file watcher
    this.logger.verbose(`Deleting asset(s) ${job.paths} from library ${job.libraryId}`);
    for (const assetPath of job.paths) {
      const asset = await this.assetRepository.getByLibraryIdAndOriginalPath(job.libraryId, assetPath);
      if (asset) {
        await this.assetRepository.remove(asset);
      }
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.LibrarySyncAssetsQueueAll, queue: QueueName.Library })
  async handleQueueSyncAssets(job: JobOf<JobName.LibrarySyncAssetsQueueAll>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.id);
    if (!library) {
      return JobStatus.Skipped;
    }

    const assetCount = await this.assetRepository.getLibraryAssetCount(job.id);
    if (!assetCount) {
      this.logger.log(`Library ${library.id} is empty, no need to check assets`);
      return JobStatus.Success;
    }

    this.logger.log(
      `Checking ${assetCount} asset(s) against import paths and exclusion patterns in library ${library.id}...`,
    );

    const offlineResult = await this.assetRepository.detectOfflineExternalAssets(
      library.id,
      library.importPaths,
      library.exclusionPatterns,
    );

    const affectedAssetCount = Number(offlineResult.numUpdatedRows);

    this.logger.log(
      `${affectedAssetCount} asset(s) out of ${assetCount} were offlined due to import paths and/or exclusion pattern(s) in library ${library.id}`,
    );

    if (affectedAssetCount === assetCount) {
      return JobStatus.Success;
    }

    this.logger.log(`Scanning library ${library.id} for assets missing from disk...`);

    let count = 0;
    const existingAssets = this.libraryRepository.streamAssetIds(library.id);
    for await (const assets of batched(existingAssets, JOBS_LIBRARY_PAGINATION_SIZE)) {
      count += assets.length;

      await this.jobRepository.queue({
        name: JobName.LibrarySyncAssets,
        data: {
          libraryId: library.id,
          importPaths: library.importPaths,
          exclusionPatterns: library.exclusionPatterns,
          assetIds: assets.map(({ id }) => id),
          progressCounter: count,
          totalAssets: assetCount,
        },
      });

      const completePercentage = ((100 * count) / assetCount).toFixed(1);

      this.logger.log(
        `Queued check of ${count} of ${assetCount} (${completePercentage} %) existing asset(s) so far in library ${library.id}`,
      );
    }

    this.logger.log(`Finished queuing ${count} asset check(s) for library ${library.id}`);

    return JobStatus.Success;
  }

  private findOrFail(id: string) {
    return findOrFail(() => this.libraryRepository.get(id), 'Library');
  }
}
