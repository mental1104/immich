import { vi } from 'vitest';
import type { JobItem } from 'src/types.js';
import { AssetType, ChecksumAlgorithm, ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { JobService } from 'src/services/job.service.js';
import { AssetEditFactory } from 'test/factories/asset-edit.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(JobService.name, () => {
  let sut: JobService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(JobService));

    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
    mocks.assetJob.startAssetTask.mockResolvedValue();
    mocks.assetJob.completeAssetTask.mockResolvedValue();
    mocks.assetJob.skipAssetTask.mockResolvedValue();
    mocks.assetJob.failAssetTask.mockResolvedValue();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onJobRun', () => {
    // 手机会以同一资产 ID 覆盖远程索引，实时事件必须保留同步流分配的代表哈希。
    const matchingChecksumCases = [
      { name: 'ordinary upload', isExternal: false, isOffline: false, hasRepresentative: false },
      { name: 'online external representative', isExternal: true, isOffline: false, hasRepresentative: true },
      { name: 'external non-representative', isExternal: true, isOffline: false, hasRepresentative: false },
      { name: 'offline external representative', isExternal: true, isOffline: true, hasRepresentative: true },
    ];

    it.each(matchingChecksumCases)(
      'publishes a stable matching checksum for $name',
      /**
       * 验证缩略图事件与普通资产响应采用同一匹配身份，且保留叠放及实况关联。
       * @param scenario 普通／外部资产、在线状态及是否已分配代表哈希的测试组合。
       * @returns 两种实时事件完成投影断言后结束；不连接数据库或任务队列。
       */
      async ({ isExternal, isOffline, hasRepresentative }) => {
        const storedChecksum = Buffer.alloc(20, 1);
        const contentChecksum = Buffer.alloc(20, 2);
        const representativeChecksum = Buffer.alloc(20, 3);
        const stackId = newUuid();
        const livePhotoVideoId = newUuid();
        const asset = AssetFactory.from({
          checksum: storedChecksum,
          checksumAlgorithm: isExternal ? ChecksumAlgorithm.sha1Path : ChecksumAlgorithm.sha1File,
          contentChecksum: isExternal ? contentChecksum : null,
          clientChecksum: hasRepresentative ? representativeChecksum : null,
          libraryId: isExternal ? newUuid() : null,
          isExternal,
          isOffline,
          stackId,
          livePhotoVideoId,
        })
          .exif()
          .build();
        const expectedChecksum =
          hasRepresentative && !isOffline
            ? representativeChecksum.toString('base64')
            : storedChecksum.toString('base64');
        // 仓库的关联 JSON 已将 EXIF 日期序列化，保持桩数据与真实查询边界一致。
        mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([
          {
            ...asset,
            faces: [],
            exifInfo: {
              ...asset.exifInfo,
              dateTimeOriginal: asset.exifInfo.dateTimeOriginal?.toISOString() ?? null,
              modifyDate: asset.exifInfo.modifyDate?.toISOString() ?? null,
              updatedAt: asset.exifInfo.updatedAt.toISOString(),
            },
          },
        ]);
        mocks.job.run.mockResolvedValue(JobStatus.Success);

        await sut.onJobRun(QueueName.ThumbnailGeneration, {
          name: JobName.AssetGenerateThumbnails,
          data: { id: asset.id, source: 'upload' },
        });

        expect(mocks.websocket.clientSend).toHaveBeenNthCalledWith(
          2,
          'AssetUploadReadyV2',
          asset.ownerId,
          expect.objectContaining({
            asset: expect.objectContaining({
              id: asset.id,
              checksum: expectedChecksum,
              libraryId: asset.libraryId,
              stackId,
              livePhotoVideoId,
            }),
            exif: expect.objectContaining({ assetId: asset.exifInfo.assetId }),
          }),
        );
        expect(mocks.websocket.clientSend).toHaveBeenCalledWith(
          'on_upload_success',
          asset.ownerId,
          expect.objectContaining({ id: asset.id, checksum: expectedChecksum }),
        );
        expect(mocks.logger.error).not.toHaveBeenCalled();
      },
    );

    it.each(matchingChecksumCases)(
      'preserves the matching checksum and edits for $name',
      /**
       * 验证编辑完成事件不会撤销已有内容匹配，且完整传递编辑步骤。
       * @param scenario 普通／外部资产、在线状态及代表分配状态；不修改测试组合。
       * @returns 编辑事件及全部身份字段断言完成后结束；不读写真实数据。
       */
      async ({ isExternal, isOffline, hasRepresentative }) => {
        const storedChecksum = Buffer.alloc(20, 1);
        const representativeChecksum = Buffer.alloc(20, 3);
        const asset = {
          ...AssetFactory.create({
            checksum: storedChecksum,
            checksumAlgorithm: isExternal ? ChecksumAlgorithm.sha1Path : ChecksumAlgorithm.sha1File,
            contentChecksum: isExternal ? Buffer.alloc(20, 2) : null,
            clientChecksum: hasRepresentative ? representativeChecksum : null,
            libraryId: isExternal ? newUuid() : null,
            isExternal,
            isOffline,
            isEdited: true,
            stackId: newUuid(),
            livePhotoVideoId: newUuid(),
          }),
          owner: null,
          stack: null,
          exifInfo: null,
          faces: [],
        };
        const edits = [AssetEditFactory.create({ assetId: asset.id })];
        const expectedChecksum =
          hasRepresentative && !isOffline
            ? representativeChecksum.toString('base64')
            : storedChecksum.toString('base64');
        mocks.asset.getById.mockResolvedValue(asset);
        mocks.assetEdit.getWithSyncInfo.mockResolvedValue(edits);
        mocks.job.run.mockResolvedValue(JobStatus.Success);

        await sut.onJobRun(QueueName.Editor, {
          name: JobName.AssetEditThumbnailGeneration,
          data: { id: asset.id },
        });

        expect(mocks.websocket.clientSend).toHaveBeenCalledExactlyOnceWith('AssetEditReadyV2', asset.ownerId, {
          asset: expect.objectContaining({
            id: asset.id,
            checksum: expectedChecksum,
            libraryId: asset.libraryId,
            stackId: asset.stackId,
            livePhotoVideoId: asset.livePhotoVideoId,
            isEdited: true,
          }),
          edit: edits,
        });
        expect(mocks.logger.error).not.toHaveBeenCalled();
      },
    );

    it('does not enqueue offline transcoding after video upload when iOS HLS is enabled', async () => {
      vi.stubEnv('IMMICH_EXPERIMENTAL_IOS_HLS', 'true');
      try {
        const item: JobItem = { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } };
        mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([
          { ...AssetFactory.create({ id: 'asset-1', type: AssetType.Video }), exifInfo: null, faces: [] },
        ]);
        mocks.job.run.mockResolvedValue(JobStatus.Success);

        await sut.onJobRun(QueueName.ThumbnailGeneration, item);

        expect(mocks.job.queueAll).toHaveBeenCalledWith([
          { name: JobName.SmartSearch, data: item.data },
          { name: JobName.AssetDetectFaces, data: item.data },
          { name: JobName.Ocr, data: item.data },
        ]);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('should queue metadata extraction when sidecar discovery is skipped', async () => {
      const job: JobItem = { name: JobName.SidecarCheck, data: { id: 'asset-1', source: 'upload' } };
      mocks.assetJob.getAssetType.mockResolvedValue({ type: AssetType.Image });
      mocks.job.run.mockResolvedValue(JobStatus.Skipped);

      await sut.onJobRun(QueueName.Sidecar, job);

      expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
        name: JobName.AssetExtractMetadata,
        data: { ...job.data, assetType: AssetType.Image, force: true },
      });
    });

    it('should process a successful job', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      const job: JobItem = { name: JobName.FileDelete, data: { files: ['path/to/file'] } };
      await sut.onJobRun(QueueName.BackgroundTask, job);

      expect(mocks.event.emit).toHaveBeenCalledWith('JobStart', QueueName.BackgroundTask, job);
      expect(mocks.event.emit).toHaveBeenCalledWith('JobSuccess', { job, response: JobStatus.Success });
      expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.BackgroundTask, job);
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it('tracks metadata extraction attempts and failures', async () => {
      const job: JobItem = { name: JobName.AssetExtractMetadata, data: { id: 'asset-1', assetType: AssetType.Image } };
      const error = new Error('metadata read failed');
      mocks.assetJob.startMetadataTask.mockResolvedValue();
      mocks.job.run.mockRejectedValue(error);

      await sut.onJobRun(QueueName.MetadataExtraction, job);

      expect(mocks.assetJob.startMetadataTask).toHaveBeenCalledWith('asset-1');
      expect(mocks.assetJob.failMetadataTask).toHaveBeenCalledWith('asset-1', error);
      expect(mocks.event.emit).toHaveBeenCalledWith('JobError', { job, error });
    });

    it('tracks thumbnail task success in the per-asset task table', async () => {
      const job: JobItem = { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } };
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.ThumbnailGeneration, job);

      expect(mocks.assetJob.startAssetTask).toHaveBeenCalledWith('asset-1', 'thumbnail-generation');
      expect(mocks.assetJob.completeAssetTask).toHaveBeenCalledWith('asset-1', 'thumbnail-generation');
    });

    it('tracks face detection task failure in the per-asset task table', async () => {
      const job: JobItem = { name: JobName.AssetDetectFaces, data: { id: 'asset-1' } };
      const error = new Error('face detection failed');
      mocks.job.run.mockRejectedValue(error);

      await sut.onJobRun(QueueName.FacialRecognition, job);

      expect(mocks.assetJob.startAssetTask).toHaveBeenCalledWith('asset-1', 'face-detection');
      expect(mocks.assetJob.failAssetTask).toHaveBeenCalledWith('asset-1', 'face-detection', error);
    });

    it('tracks RAW pairing attempts in the per-asset task table', async () => {
      const job: JobItem = { name: JobName.AssetStackRawPair, data: { assetId: 'raw-1', ownerId: 'owner-1' } };
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.RawPairing, job);

      expect(mocks.assetJob.startAssetTask).toHaveBeenCalledWith('raw-1', 'raw-pairing');
      expect(mocks.assetJob.completeAssetTask).toHaveBeenCalledWith('raw-1', 'raw-pairing');
    });

    const tests: Array<{ item: JobItem; jobs: JobName[]; stub?: any }> = [
      {
        item: { name: JobName.SidecarCheck, data: { id: 'asset-1' } },
        jobs: [JobName.AssetExtractMetadata],
      },
      {
        item: { name: JobName.SidecarCheck, data: { id: 'asset-1' } },
        jobs: [JobName.AssetExtractMetadata],
      },
      {
        item: { name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.AssetGenerateThumbnails],
      },
      {
        item: { name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.PersonGenerateThumbnail, data: { ownerId: 'owner-1', personGroupId: 'person-group-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
        jobs: [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.Ocr],
        stub: [AssetFactory.create({ id: 'asset-1' })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
        jobs: [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.Ocr, JobName.AssetEncodeVideo],
        stub: [AssetFactory.create({ id: 'asset-1', type: AssetType.Video })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.Ocr],
        stub: [AssetFactory.create({ id: 'asset-1', livePhotoVideoId: newUuid() })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.Ocr, JobName.AssetEncodeVideo],
        stub: [AssetFactory.create({ id: 'asset-1', type: AssetType.Video })],
      },
      {
        item: { name: JobName.SmartSearch, data: { id: 'asset-1' } },
        jobs: [JobName.AssetDetectDuplicates],
      },
      {
        item: { name: JobName.AssetDetectFaces, data: { id: 'asset-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.FacialRecognition, data: { id: 'asset-1' } },
        jobs: [],
      },
    ];

    for (const { item, jobs, stub } of tests) {
      it(`should queue ${jobs.length} jobs when a ${item.name} job finishes successfully`, async () => {
        mocks.assetJob.getAssetType.mockResolvedValue({ type: AssetType.Image });
        if (stub) {
          mocks.asset.getById.mockResolvedValue(stub[0]);
          mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue(stub);
        }

        mocks.job.run.mockResolvedValue(JobStatus.Success);

        await sut.onJobRun(QueueName.BackgroundTask, item);

        if (jobs.length > 1) {
          expect(mocks.job.queueAll).toHaveBeenCalledWith(
            jobs.map((jobName) => ({ name: jobName, data: expect.anything() })),
          );
        } else {
          expect(mocks.job.queue).toHaveBeenCalledTimes(jobs.length);
          for (const jobName of jobs) {
            expect(mocks.job.queue).toHaveBeenCalledWith({ name: jobName, data: expect.anything() });
          }
        }
      });

      it(`should not queue any jobs when ${item.name} fails`, async () => {
        mocks.job.run.mockResolvedValue(JobStatus.Failed);

        await sut.onJobRun(QueueName.BackgroundTask, item);

        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      });
    }
  });
});
