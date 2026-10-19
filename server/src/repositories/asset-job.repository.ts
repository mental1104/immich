import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetStatus, AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import {
  ForkAssetTask,
  type ForkAssetTaskName,
  ForkAssetTaskState,
} from 'src/schema/tables/fork-asset-task-status.table.js';
import {
  anyUuid,
  asUuid,
  withAudioStream,
  withDefaultVisibility,
  withEdits,
  withExif,
  withExifInner,
  withFaces,
  withFilePath,
  withFiles,
  withVideoFormat,
  withVideoStream,
} from 'src/utils/database.js';
import { mimeTypes } from 'src/utils/mime-types.js';

const METADATA_EXTRACTION_MAX_ATTEMPTS = 3;

@Injectable()
export class AssetJobRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getForSearchDuplicatesJob(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', asUuid(id))
      .leftJoin('smart_search', 'asset.id', 'smart_search.assetId')
      .select(['id', 'type', 'ownerId', 'duplicateId', 'stackId', 'visibility', 'smart_search.embedding'])
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForSidecarWriteJob(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', asUuid(id))
      .select(['id', 'originalPath'])
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .$call(withExifInner)
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForSidecarCheckJob(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', asUuid(id))
      .select(['id', 'originalPath'])
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ force: false, fullsizeEnabled: true }], stream: true })
  streamForThumbnailJob(options: { force: boolean | undefined; fullsizeEnabled: boolean }) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.isEdited'])
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden))
      .$if(!options.force, (qb) =>
        qb
          // If there aren't any entries, metadata extraction hasn't run yet which is required for thumbnails
          .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
          .where(({ and, eb, exists, not, or, selectFrom }) => {
            const file = (type: AssetFileType) =>
              selectFrom('asset_file').whereRef('assetId', '=', 'asset.id').where('type', '=', sql.lit(type));

            const conditions = [
              not(exists(file(AssetFileType.Thumbnail))),
              not(exists(file(AssetFileType.Preview))),
              and([
                eb('asset.isEdited', '=', sql.lit(true)),
                not(exists(file(AssetFileType.FullSize).where('asset_file.isEdited', '=', sql.lit(true)))),
              ]),
              eb('asset.thumbhash', 'is', null),
            ];

            if (options.fullsizeEnabled) {
              const isWebUnsupported = sql.join(
                Object.keys(mimeTypes.webUnsupportedImage).map((ext) => sql.lit(`%${ext}`)),
              );
              conditions.push(
                and([
                  not(exists(file(AssetFileType.FullSize))),
                  eb(sql`f_unaccent(asset."originalFileName")`, 'like', sql`any(array[${isWebUnsupported}]::text[])`),
                ]),
              );
            }

            return or(conditions);
          }),
      )
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForMigrationJob(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId'])
      .select(withFiles)
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForGenerateThumbnailJob(id: string) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.visibility',
        'asset.originalFileName',
        'asset.originalPath',
        'asset.ownerId',
        'asset.thumbhash',
        'asset.type',
      ])
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset_file')
            .select(columns.assetFilesForThumbnail)
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', 'in', [AssetFileType.Thumbnail, AssetFileType.Preview, AssetFileType.FullSize]),
        ).as('files'),
      )
      .select(withEdits)
      .$call(withExifInner)
      .leftJoin('asset_video', 'asset_video.assetId', 'asset.id')
      .select((eb) => withVideoStream(eb).as('videoStream'))
      .select((eb) => withVideoFormat(eb).as('format'))
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForMetadataExtraction(id: string) {
    return this.db
      .selectFrom('asset')
      .select(columns.asset)
      .select(withFaces)
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .innerJoin('user', 'user.id', 'asset.ownerId')
      .select(['user.clusterGroupId'])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  getAssetType(id: string) {
    return this.db.selectFrom('asset').select('type').where('id', '=', id).executeTakeFirst();
  }

  getAssetTypes(ids: string[]) {
    return this.db.selectFrom('asset').select(['id', 'type']).where('id', 'in', ids).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getLockedPropertiesForMetadataExtraction(assetId: string) {
    return this.db
      .selectFrom('asset_exif')
      .select('asset_exif.lockedProperties')
      .where('asset_exif.assetId', '=', assetId)
      .executeTakeFirst()
      .then((row) => row?.lockedProperties ?? []);
  }

  @GenerateSql({ params: [DummyValue.UUID, AssetFileType.Thumbnail] })
  getAlbumThumbnailFiles(id: string, fileType?: AssetFileType) {
    return this.db
      .selectFrom('asset_file')
      .select(columns.assetFiles)
      .where('asset_file.assetId', '=', id)
      .$if(!!fileType, (qb) => qb.where('asset_file.type', '=', fileType!))
      .execute();
  }

  private assetsWithPreviews() {
    return this.db
      .selectFrom('asset')
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where('asset.deletedAt', 'is', null)
      .innerJoin('asset_job_status as job_status', 'assetId', 'asset.id')
      .where((eb) =>
        eb.exists((qb) =>
          qb
            .selectFrom('asset_file')
            .whereRef('assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      );
  }

  @GenerateSql({ params: [], stream: true })
  streamForSearchDuplicates(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.deletedAt', 'is', null)
      .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
      .$call(withDefaultVisibility)
      .$if(!force, (qb) =>
        qb
          .innerJoin('asset_job_status as job_status', 'job_status.assetId', 'asset.id')
          .where('job_status.duplicatesDetectedAt', 'is', null),
      )
      .stream();
  }

  @GenerateSql({ params: [], stream: true })
  streamForEncodeClip(force?: boolean) {
    return this.assetsWithPreviews()
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb.where((eb) => eb.not((eb) => eb.exists(eb.selectFrom('smart_search').whereRef('assetId', '=', 'asset.id')))),
      )
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForClipEncoding(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.visibility'])
      .select((eb) => withFiles(eb, AssetFileType.Preview))
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForDetectFacesJob(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.visibility'])
      .$call(withExifInner)
      .select((eb) => withFaces(eb, true, true))
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('asset_file')
            .select(columns.assetFiles)
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', sql.lit(AssetFileType.Preview))
            .orderBy('asset_file.isEdited', 'desc')
            .limit(sql.lit(1)),
        ).as('previewFile'),
      )
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForOcr(id: string) {
    return this.db
      .selectFrom('asset')
      .select((eb) => ['asset.visibility', withFilePath(eb, AssetFileType.Preview).as('previewFile')])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getForSyncAssets(ids: string[]) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.isOffline',
        'asset.libraryId',
        'asset.originalPath',
        'asset.status',
        'asset.fileModifiedAt',
      ])
      .where('asset.id', '=', anyUuid(ids))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForAssetDeletion(id: string) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.visibility',
        'asset.libraryId',
        'asset.ownerId',
        'asset.livePhotoVideoId',
        'asset.originalPath',
        'asset.isOffline',
      ])
      .$call(withExif)
      .select(withFiles)
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('stack')
            .whereRef('stack.id', '=', 'asset.stackId')
            .select((eb) => [
              'stack.id',
              'stack.primaryAssetId',
              jsonArrayFrom(
                eb
                  .selectFrom('asset as stack_asset')
                  .select(['stack_asset.id'])
                  .whereRef('stack_asset.stackId', '=', 'stack.id')
                  .whereRef('stack_asset.id', '!=', 'stack.primaryAssetId')
                  .where('stack_asset.visibility', '=', sql.val(AssetVisibility.Timeline))
                  .where('stack_asset.status', '!=', sql.val(AssetStatus.Deleted)),
              ).as('assets'),
            ])
            .as('stack_result'),
        (join) => join.onTrue(),
      )
      .select((eb) =>
        eb.fn
          .toJson(eb.table('stack_result'))
          .$castTo<{ id: string; primaryAssetId: string; assets: { id: string }[] } | null>()
          .as('stack'),
      )
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [], stream: true })
  streamForVideoConversion(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.type', '=', sql.lit(AssetType.Video))
      .$if(!force, (qb) =>
        qb.where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_file')
                .select('asset_file.id')
                .whereRef('asset_file.assetId', '=', 'asset.id')
                .where('asset_file.type', '=', sql.lit(AssetFileType.EncodedVideo)),
            ),
          ),
        ),
      )
      .where('asset.deletedAt', 'is', null)
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForVideoConversion(id: string) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .innerJoin('asset_video', 'asset_video.assetId', 'asset.id')
      .leftJoin('asset_audio', 'asset_audio.assetId', 'asset.id')
      .select(['asset.id', 'asset.ownerId', 'asset.originalPath'])
      .select(withFiles)
      .select((eb) => withAudioStream(eb).as('audioStream'))
      .select((eb) => withVideoStream(eb).$notNull().as('videoStream'))
      .select((eb) => withVideoFormat(eb).$notNull().as('format'))
      .where('asset.id', '=', id)
      .where('asset.type', '=', sql.lit(AssetType.Video))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [], stream: true })
  streamForMetadataExtraction(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.type'])
      .leftJoin('asset_job_status as legacy_status', 'legacy_status.assetId', 'asset.id')
      .leftJoin('fork_asset_task_status as task_status', (join) =>
        join
          .onRef('task_status.assetId', '=', 'asset.id')
          .on('task_status.taskName', '=', ForkAssetTask.MetadataExtraction),
      )
      .$if(!force, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb.and([eb('task_status.assetId', 'is', null), eb('legacy_status.metadataExtractedAt', 'is', null)]),
            eb.and([
              eb('task_status.status', '=', ForkAssetTaskState.Failed),
              eb('task_status.attempts', '<', METADATA_EXTRACTION_MAX_ATTEMPTS),
            ]),
          ]),
        ),
      )
      .where('asset.deletedAt', 'is', null)
      .stream();
  }

  async queueMetadataTasks(assetIds: string[], force = false): Promise<string[]> {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0) {
      return [];
    }

    const now = new Date();
    const rows = await this.db
      .insertInto('fork_asset_task_status')
      .values(
        ids.map((assetId) => ({
          assetId,
          taskName: ForkAssetTask.MetadataExtraction,
          status: ForkAssetTaskState.Queued,
          queuedAt: now,
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(['assetId', 'taskName'])
          .doUpdateSet((eb) => ({
            status: ForkAssetTaskState.Queued,
            attempts: force ? 0 : eb.ref('fork_asset_task_status.attempts'),
            generation: force
              ? sql<number>`"fork_asset_task_status"."generation" + 1`
              : eb.ref('fork_asset_task_status.generation'),
            queuedAt: now,
            startedAt: null,
            completedAt: null,
            failedAt: null,
            errorMessage: null,
            updatedAt: now,
          }))
          .where((eb) =>
            force
              ? eb('fork_asset_task_status.assetId', 'is not', null)
              : eb.and([
                  eb('fork_asset_task_status.status', '=', ForkAssetTaskState.Failed),
                  eb('fork_asset_task_status.attempts', '<', METADATA_EXTRACTION_MAX_ATTEMPTS),
                ]),
          ),
      )
      .returning('assetId')
      .execute();

    return rows.map(({ assetId }) => assetId);
  }

  async getTaskStatuses(assetId: string) {
    return this.db
      .selectFrom('fork_asset_task_status')
      .select([
        'taskName',
        'status',
        'attempts',
        'generation',
        'queuedAt',
        'startedAt',
        'completedAt',
        'failedAt',
        'errorMessage',
      ])
      .where('assetId', '=', asUuid(assetId))
      .orderBy('taskName', 'asc')
      .execute();
  }

  async getMetadataExtractionProgress() {
    const counts = await this.db
      .selectFrom('asset')
      .leftJoin('asset_job_status as legacy_status', 'legacy_status.assetId', 'asset.id')
      .leftJoin('fork_asset_task_status as task_status', (join) =>
        join
          .onRef('task_status.assetId', '=', 'asset.id')
          .on('task_status.taskName', '=', ForkAssetTask.MetadataExtraction),
      )
      .where('asset.deletedAt', 'is', null)
      .select([
        sql<number>`count(*)`.as('total'),
        sql<number>`count(*) filter (where task_status.status = ${ForkAssetTaskState.Completed} or (task_status."assetId" is null and legacy_status."metadataExtractedAt" is not null))`.as(
          'completed',
        ),
        sql<number>`count(*) filter (where task_status.status = ${ForkAssetTaskState.Queued})`.as('queued'),
        sql<number>`count(*) filter (where task_status.status = ${ForkAssetTaskState.Running})`.as('running'),
        sql<number>`count(*) filter (where task_status.status = ${ForkAssetTaskState.Failed})`.as('failed'),
        sql<number>`count(*) filter (where task_status.status = ${ForkAssetTaskState.Skipped})`.as('skipped'),
        sql<number>`count(*) filter (where task_status."assetId" is null and legacy_status."metadataExtractedAt" is null)`.as(
          'notStarted',
        ),
      ])
      .executeTakeFirstOrThrow();

    return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])) as {
      total: number;
      completed: number;
      queued: number;
      running: number;
      failed: number;
      skipped: number;
      notStarted: number;
    };
  }

  async queueAssetTasks(taskName: ForkAssetTaskName, assetIds: string[]): Promise<void> {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0) {
      return;
    }

    const now = new Date();
    await this.db
      .insertInto('fork_asset_task_status')
      .values(ids.map((assetId) => ({ assetId, taskName, status: ForkAssetTaskState.Queued, queuedAt: now })))
      .onConflict((oc) =>
        oc.columns(['assetId', 'taskName']).doUpdateSet(() => ({
          status: ForkAssetTaskState.Queued,
          generation: sql<number>`"fork_asset_task_status"."generation" + 1`,
          queuedAt: now,
          startedAt: null,
          completedAt: null,
          failedAt: null,
          errorMessage: null,
          updatedAt: now,
        })),
      )
      .execute();
  }

  async startAssetTask(assetId: string, taskName: ForkAssetTaskName): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto('fork_asset_task_status')
      .values({ assetId, taskName, status: ForkAssetTaskState.Running, attempts: 1, startedAt: now })
      .onConflict((oc) =>
        oc.columns(['assetId', 'taskName']).doUpdateSet(() => ({
          status: ForkAssetTaskState.Running,
          attempts: sql<number>`"fork_asset_task_status"."attempts" + 1`,
          startedAt: now,
          completedAt: null,
          failedAt: null,
          errorMessage: null,
          updatedAt: now,
        })),
      )
      .execute();
  }

  async completeAssetTask(assetId: string, taskName: ForkAssetTaskName): Promise<void> {
    const now = new Date();
    await this.db
      .updateTable('fork_asset_task_status')
      .set({
        status: ForkAssetTaskState.Completed,
        completedAt: now,
        failedAt: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where('assetId', '=', asUuid(assetId))
      .where('taskName', '=', taskName)
      .execute();
  }

  async skipAssetTask(assetId: string, taskName: ForkAssetTaskName): Promise<void> {
    const now = new Date();
    await this.db
      .updateTable('fork_asset_task_status')
      .set({ status: ForkAssetTaskState.Skipped, completedAt: now, failedAt: null, errorMessage: null, updatedAt: now })
      .where('assetId', '=', asUuid(assetId))
      .where('taskName', '=', taskName)
      .execute();
  }

  async failAssetTask(assetId: string, taskName: ForkAssetTaskName, error: unknown): Promise<void> {
    const now = new Date();
    const message = String(error instanceof Error ? error.message : error).slice(0, 4000);
    await this.db
      .updateTable('fork_asset_task_status')
      .set({ status: ForkAssetTaskState.Failed, failedAt: now, errorMessage: message, updatedAt: now })
      .where('assetId', '=', asUuid(assetId))
      .where('taskName', '=', taskName)
      .execute();
  }

  async startMetadataTask(assetId: string): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto('fork_asset_task_status')
      .values({
        assetId,
        taskName: ForkAssetTask.MetadataExtraction,
        status: ForkAssetTaskState.Running,
        attempts: 1,
        startedAt: now,
      })
      .onConflict((oc) =>
        oc.columns(['assetId', 'taskName']).doUpdateSet((_eb) => ({
          status: ForkAssetTaskState.Running,
          attempts: sql<number>`"fork_asset_task_status"."attempts" + 1`,
          startedAt: now,
          completedAt: null,
          failedAt: null,
          errorMessage: null,
          updatedAt: now,
        })),
      )
      .execute();
  }

  async completeMetadataTask(assetId: string): Promise<void> {
    const now = new Date();
    await this.db
      .updateTable('fork_asset_task_status')
      .set({
        status: ForkAssetTaskState.Completed,
        completedAt: now,
        failedAt: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where('assetId', '=', assetId)
      .where('taskName', '=', ForkAssetTask.MetadataExtraction)
      .execute();
  }

  async failMetadataTask(assetId: string, error: unknown): Promise<void> {
    const now = new Date();
    const message = String(error instanceof Error ? error.message : error).slice(0, 4000);
    await this.db
      .updateTable('fork_asset_task_status')
      .set({ status: ForkAssetTaskState.Failed, failedAt: now, errorMessage: message, updatedAt: now })
      .where('assetId', '=', assetId)
      .where('taskName', '=', ForkAssetTask.MetadataExtraction)
      .execute();
  }

  private storageTemplateAssetQuery() {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.type',
        'asset.checksum',
        'asset.originalPath',
        'asset.isExternal',
        'asset.visibility',
        'asset.originalFileName',
        'asset.livePhotoVideoId',
        'asset.fileCreatedAt',
        'asset_exif.timeZone',
        'asset_exif.fileSizeInByte',
        'asset_exif.make',
        'asset_exif.model',
        'asset_exif.lensModel',
      ])
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .where('asset.deletedAt', 'is', null);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForStorageTemplateJob(id: string, options?: { includeHidden?: boolean }) {
    return this.storageTemplateAssetQuery()
      .where('asset.id', '=', id)
      .$if(!options?.includeHidden, (qb) => qb.where('asset.visibility', '!=', AssetVisibility.Hidden))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [], stream: true })
  streamForStorageTemplateJob() {
    return this.storageTemplateAssetQuery().where('asset.visibility', '!=', AssetVisibility.Hidden).stream();
  }

  @GenerateSql({ params: [DummyValue.DATE], stream: true })
  streamForDeletedJob(trashedBefore: Date) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'isOffline'])
      .where('asset.deletedAt', '<=', trashedBefore)
      .stream();
  }

  @GenerateSql({ params: [], stream: true })
  streamForSidecar(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb.where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_file')
                .select('asset_file.id')
                .whereRef('asset_file.assetId', '=', 'asset.id')
                .where('asset_file.type', '=', AssetFileType.Sidecar),
            ),
          ),
        ),
      )
      .stream();
  }

  @GenerateSql({ params: [], stream: true })
  streamForDetectFacesJob(force?: boolean) {
    return this.assetsWithPreviews()
      .$if(force === false, (qb) => qb.where('job_status.facesRecognizedAt', 'is', null))
      .select(['asset.id'])
      .orderBy('asset.fileCreatedAt', 'desc')
      .stream();
  }

  @GenerateSql({ params: [], stream: true })
  streamForOcrJob(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb
          .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
          .where('asset_job_status.ocrAt', 'is', null),
      )
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .stream();
  }

  @GenerateSql({ params: [DummyValue.DATE], stream: true })
  streamForMigrationJob() {
    return this.db.selectFrom('asset').select(['id']).where('asset.deletedAt', 'is', null).stream();
  }
}
