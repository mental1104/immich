import { vi } from 'vitest';
import type { JobItem } from 'src/types.js';
import { AssetType, ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { JobService } from 'src/services/job.service.js';
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
    it('does not enqueue offline transcoding after video upload when iOS HLS is enabled', async () => {
      vi.stubEnv('IMMICH_EXPERIMENTAL_IOS_HLS', 'true');
      try {
        const item: JobItem = { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } };
        mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([
          AssetFactory.create({ id: 'asset-1', type: AssetType.Video }),
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
        jobs: [],
        stub: [AssetFactory.create({ id: 'asset-1' })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
        jobs: [],
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
        jobs: [],
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
