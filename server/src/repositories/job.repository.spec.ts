import { AssetType, JobName, JobStatus, QueueName } from 'src/enum.js';
import { shouldPauseVideoMetadataExtraction } from 'src/repositories/job.repository.js';

describe('shouldPauseVideoMetadataExtraction', () => {
  it('pauses on I/O pressure even when CPU is mostly idle', () => {
    expect(
      shouldPauseVideoMetadataExtraction({
        paused: false,
        cpuPressure: 0,
        ioPressure: 6,
        cpuBusy: 12,
        ioWait: 1,
        diskBusy: 20,
        photoWorkPending: false,
      }),
    ).toBe(true);
  });

  it('waits for lower load before resuming and avoids threshold flapping', () => {
    const load = { cpuPressure: 6, ioPressure: 1, cpuBusy: 45, ioWait: 2, diskBusy: 55, photoWorkPending: false };
    expect(shouldPauseVideoMetadataExtraction({ ...load, paused: true })).toBe(true);
    expect(shouldPauseVideoMetadataExtraction({ ...load, paused: false })).toBe(false);
    expect(shouldPauseVideoMetadataExtraction({ ...load, cpuPressure: 4, paused: true })).toBe(false);
  });

  it('honors CPU pressure as a pause condition', () => {
    expect(
      shouldPauseVideoMetadataExtraction({
        paused: false,
        cpuPressure: 12,
        ioPressure: 0,
        cpuBusy: 20,
        ioWait: 0,
        diskBusy: null,
        photoWorkPending: false,
      }),
    ).toBe(true);
  });

  it('keeps videos queued while any photo metadata work remains', () => {
    expect(
      shouldPauseVideoMetadataExtraction({
        paused: false,
        cpuPressure: 0,
        ioPressure: 0,
        cpuBusy: 10,
        ioWait: 0,
        diskBusy: 0,
        photoWorkPending: true,
      }),
    ).toBe(true);
  });
});

describe('metadata extraction queue classification', () => {
  it('uses one queue and prioritizes photos before videos', async () => {
    const { JobRepository } = await import('src/repositories/job.repository.js');
    const repository = Object.create(JobRepository.prototype) as InstanceType<typeof JobRepository>;
    repository['handlers'] = {
      [JobName.AssetExtractMetadata]: {
        jobName: JobName.AssetExtractMetadata,
        queueName: QueueName.MetadataExtraction,
        handler: () => Promise.resolve('success' as never),
        label: 'test',
      },
    };

    expect(repository['getQueueName'](JobName.AssetExtractMetadata)).toBe(QueueName.MetadataExtraction);
    expect(
      repository['getJobOptions']({
        name: JobName.AssetExtractMetadata,
        data: { id: 'asset-1', assetType: AssetType.Image },
      }),
    ).toEqual({ jobId: 'asset-1', priority: 1 });
    expect(
      repository['getJobOptions']({
        name: JobName.AssetExtractMetadata,
        data: { id: 'asset-2', assetType: AssetType.Video },
      }),
    ).toEqual({ jobId: 'asset-2', priority: 2 });
  });
});

describe('disabled job queues', () => {
  it('drops automatic disabled jobs before tracking or enqueueing and skips their handlers', async () => {
    const { JobRepository } = await import('src/repositories/job.repository.js');
    const repository = Object.create(JobRepository.prototype) as InstanceType<typeof JobRepository>;
    const handler = vi.fn().mockResolvedValue(JobStatus.Success);
    repository['handlers'] = Object.fromEntries(
      [
        [JobName.AssetEncodeVideo, QueueName.VideoConversion],
        [JobName.StorageTemplateMigrationSingle, QueueName.StorageTemplateMigration],
        [JobName.AssetFileMigration, QueueName.Migration],
      ].map(([jobName, queueName]) => [jobName, { jobName, queueName, handler, label: 'disabled' }]),
    );
    repository['moduleRef'] = {
      get: vi.fn(() => {
        throw new Error('must not persist disabled tasks');
      }),
    } as never;
    const items = [JobName.AssetEncodeVideo, JobName.StorageTemplateMigrationSingle, JobName.AssetFileMigration].map(
      (name) => ({ name, data: { id: 'asset-1' } }) as never,
    );
    await repository.queueAll(items);
    for (const item of items) {
      await expect(repository.run(item)).resolves.toBe(JobStatus.Skipped);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(repository['moduleRef'].get).not.toHaveBeenCalled();
  });
});
