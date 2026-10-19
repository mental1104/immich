import { getQueueToken } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { JobsOptions, Queue, Worker } from 'bullmq';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import type { JobCounts, JobItem, JobOf } from 'src/types.js';
import { JobConfig } from 'src/decorators.js';
import { QueueJobResponseDto, QueueJobSearchDto } from 'src/dtos/queue.dto.js';
import {
  AssetType,
  ImmichWorker,
  JobName,
  JobStatus,
  MetadataKey,
  QueueCleanType,
  QueueJobStatus,
  QueueName,
} from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ForkAssetTask, type ForkAssetTaskName } from 'src/schema/tables/fork-asset-task-status.table.js';
import { ImmichStartupError, getKeyByValue, getMethodNames } from 'src/utils/misc.js';

type JobMapItem = {
  jobName: JobName;
  queueName: QueueName;
  handler: (job: JobOf<any>) => Promise<JobStatus>;
  label: string;
};

const WORKER_WATCH_INTERVAL_MS = 30_000;
const VIDEO_METADATA_LOAD_CHECK_INTERVAL_MS = 5000;

const getAssetTaskName = (item: JobItem): ForkAssetTaskName | undefined => {
  switch (item.name) {
    case JobName.AssetGenerateThumbnails: {
      return ForkAssetTask.ThumbnailGeneration;
    }
    case JobName.AssetDetectFaces: {
      return ForkAssetTask.FaceDetection;
    }
    case JobName.AssetEncodeVideo: {
      return ForkAssetTask.VideoEncoding;
    }
    default: {
      return;
    }
  }
};

const getAssetTaskId = (item: JobItem): string | undefined => {
  const data = item.data as { id?: string; assetId?: string } | undefined;
  return data?.id ?? data?.assetId;
};

export const shouldPauseVideoMetadataExtraction = (metrics: {
  paused: boolean;
  cpuPressure: number | null;
  ioPressure: number | null;
  cpuBusy: number;
  ioWait: number;
  diskBusy: number | null;
  photoWorkPending: boolean;
}) => {
  const { paused, cpuPressure, ioPressure, cpuBusy, ioWait, diskBusy, photoWorkPending } = metrics;
  if (photoWorkPending) {
    return true;
  }

  if (paused) {
    const cpuPressureIsHigh = cpuPressure !== null && cpuPressure >= 5;
    const ioPressureIsHigh = ioPressure !== null && ioPressure >= 2;
    const diskIsBusy = diskBusy !== null && diskBusy >= 60;
    return cpuPressureIsHigh || ioPressureIsHigh || diskIsBusy || cpuBusy >= 50 || ioWait >= 5;
  }

  return (
    (cpuPressure !== null && cpuPressure >= 10) ||
    (ioPressure !== null && ioPressure >= 5) ||
    (diskBusy !== null && diskBusy >= 80) ||
    cpuBusy >= 65 ||
    ioWait >= 10
  );
};

@Injectable()
export class JobRepository {
  private workers: Partial<Record<QueueName, Worker>> = {};
  private handlers: Partial<Record<JobName, JobMapItem>> = {};
  private workerWatcher?: ReturnType<typeof setInterval>;
  private videoMetadataWatcher?: ReturnType<typeof setInterval>;
  private videoMetadataPausedForLoad = true;
  private microservicesPresent = true;
  private previousCpuStats?: { idle: number; total: number; ioWait: number };
  private previousDiskStats?: { timestamp: number; devices: Map<string, number> };

  constructor(
    private moduleRef: ModuleRef,
    private configRepository: ConfigRepository,
    private eventRepository: EventRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(JobRepository.name);
  }

  setup(services: (new (...args: any[]) => unknown)[]) {
    const reflector = this.moduleRef.get(Reflector, { strict: false });

    // discovery
    for (const Service of services) {
      const instance = this.moduleRef.get<any>(Service);
      for (const methodName of getMethodNames(instance)) {
        const handler = instance[methodName];
        const config = reflector.get<JobConfig>(MetadataKey.JobConfig, handler);
        if (!config) {
          continue;
        }

        const { name: jobName, queue: queueName } = config;
        const label = `${Service.name}.${handler.name}`;

        // one handler per job
        if (Object.hasOwn(this.handlers, jobName)) {
          const jobKey = getKeyByValue(JobName, jobName);
          const errorMessage = `Failed to add job handler for ${label}`;
          this.logger.error(
            `${errorMessage}. JobName.${jobKey} is already handled by ${this.handlers[jobName]!.label}.`,
          );
          throw new ImmichStartupError(errorMessage);
        }

        this.handlers[jobName] = {
          label,
          jobName,
          queueName,
          handler: handler.bind(instance),
        };

        this.logger.verbose(`Added job handler: ${jobName} => ${label}`);
      }
    }

    // no missing handlers
    for (const [jobKey, jobName] of Object.entries(JobName)) {
      const item = this.handlers[jobName];
      if (!item) {
        const errorMessage = `Failed to find job handler for Job.${jobKey} ("${jobName}")`;
        this.logger.error(
          `${errorMessage}. Make sure to add the @OnJob({ name: JobName.${jobKey}, queue: QueueName.XYZ }) decorator for the new job.`,
        );
        throw new ImmichStartupError(errorMessage);
      }
    }
  }

  startWorkers() {
    const { bull } = this.configRepository.getEnv();
    for (const queueName of Object.values(QueueName)) {
      this.logger.debug(`Starting worker for queue: ${queueName}`);
      this.workers[queueName] = new Worker(
        queueName,
        (job) => this.eventRepository.emit('JobRun', queueName, job as JobItem),
        { ...bull.config, concurrency: 1, name: ImmichWorker.Microservices },
      );
    }
    // Video metadata may scan every packet in a file. Keep that worker stopped until
    // both CPU and I/O pressure have remained low for a complete sample interval.
    void this.workers[QueueName.VideoMetadataExtraction]?.pause(true);
    this.videoMetadataWatcher ??= setInterval(
      () => void this.updateVideoMetadataWorker(),
      VIDEO_METADATA_LOAD_CHECK_INTERVAL_MS,
    );
    void this.updateVideoMetadataWorker();
  }

  watchWorkers() {
    this.workerWatcher ??= setInterval(() => void this.checkWorkers(), WORKER_WATCH_INTERVAL_MS);
  }

  teardown() {
    if (this.videoMetadataWatcher) {
      clearInterval(this.videoMetadataWatcher);
      this.videoMetadataWatcher = undefined;
    }
    if (!this.workerWatcher) {
      return;
    }

    clearInterval(this.workerWatcher);
    this.workerWatcher = undefined;
  }

  private async updateVideoMetadataWorker() {
    const worker = this.workers[QueueName.VideoMetadataExtraction];
    if (!worker) {
      return;
    }

    try {
      const [cpuPressure, ioPressure, cpuUsage, diskUsage] = await Promise.all([
        readFile('/proc/pressure/cpu', 'utf8').catch(() => null),
        readFile('/proc/pressure/io', 'utf8').catch(() => null),
        readFile('/proc/stat', 'utf8'),
        readFile('/proc/diskstats', 'utf8').catch(() => null),
      ]);
      const cpuSome = cpuPressure ? this.readPressure(cpuPressure) : null;
      const ioSome = ioPressure ? this.readPressure(ioPressure) : null;
      const { busyPercent, ioWaitPercent } = this.readCpuUsage(cpuUsage);
      const diskBusyPercent = diskUsage ? this.readDiskBusyPercent(diskUsage) : null;
      const photoJobs = await this.getQueue(QueueName.MetadataExtraction).getJobCounts(
        'active',
        'waiting',
        'paused',
        'delayed',
      );
      const photoWorkPending = photoJobs.active + photoJobs.waiting + photoJobs.paused + photoJobs.delayed > 0;
      // Require meaningful CPU headroom and little I/O contention before launching
      // another video probe. Current active probes are allowed to finish.
      const shouldPause = shouldPauseVideoMetadataExtraction({
        paused: this.videoMetadataPausedForLoad,
        cpuPressure: cpuSome,
        ioPressure: ioSome,
        cpuBusy: busyPercent,
        ioWait: ioWaitPercent,
        diskBusy: diskBusyPercent,
        photoWorkPending,
      });
      if (shouldPause !== this.videoMetadataPausedForLoad) {
        this.videoMetadataPausedForLoad = shouldPause;
        if (shouldPause) {
          await worker.pause(true);
          this.logger.log(
            `Pausing video metadata extraction (photo work pending: ${photoWorkPending}, CPU pressure ${cpuSome?.toFixed(1) ?? 'n/a'}%, I/O pressure ${ioSome?.toFixed(1) ?? 'n/a'}%, CPU busy ${busyPercent.toFixed(1)}%, I/O wait ${ioWaitPercent.toFixed(1)}%, disk busy ${diskBusyPercent?.toFixed(1) ?? 'n/a'}%)`,
          );
        } else {
          void worker.resume();
          this.logger.log(
            `Resuming video metadata extraction (photo work pending: ${photoWorkPending}, CPU pressure ${cpuSome?.toFixed(1) ?? 'n/a'}%, I/O pressure ${ioSome?.toFixed(1) ?? 'n/a'}%, CPU busy ${busyPercent.toFixed(1)}%, I/O wait ${ioWaitPercent.toFixed(1)}%, disk busy ${diskBusyPercent?.toFixed(1) ?? 'n/a'}%)`,
          );
        }
      }
    } catch (error) {
      // If basic Linux metrics are unavailable, do not permanently strand queued work.
      if (this.videoMetadataPausedForLoad) {
        this.videoMetadataPausedForLoad = false;
        void worker.resume();
        this.logger.warn(`Unable to read host load metrics; allowing video metadata extraction: ${error}`);
      }
    }
  }

  private readPressure(contents: string): number | null {
    const line = contents.split(/[\r\n]+/u).find((row) => row.startsWith('some '));
    const value = line?.match(/avg10=([\d.]+)/)?.[1];
    return value ? Number(value) : null;
  }

  private readCpuUsage(contents: string): { busyPercent: number; ioWaitPercent: number } {
    const values =
      contents
        .split(/[\r\n]+/u, 1)[0]
        ?.trim()
        .split(/\s+/)
        .slice(1)
        .map(Number) ?? [];
    if (values.length < 4) {
      return { busyPercent: 100, ioWaitPercent: 100 };
    }
    const idle = values[3] + (values[4] ?? 0);
    const ioWait = values[4] ?? 0;
    // guest and guest_nice are already included in user and nice.
    const total = values.slice(0, 8).reduce((sum, value) => sum + value, 0);
    const previous = this.previousCpuStats;
    this.previousCpuStats = { idle, total, ioWait };
    if (!previous) {
      return { busyPercent: 100, ioWaitPercent: 100 };
    }
    if (total <= previous.total) {
      return { busyPercent: 100, ioWaitPercent: 100 };
    }
    return {
      busyPercent: Math.max(0, Math.min(100, 100 * (1 - (idle - previous.idle) / (total - previous.total)))),
      ioWaitPercent: Math.max(0, Math.min(100, (100 * (ioWait - previous.ioWait)) / (total - previous.total))),
    };
  }

  private readDiskBusyPercent(contents: string): number | null {
    const timestamp = Date.now();
    const devices = new Map<string, number>();
    for (const line of contents.split(/[\r\n]+/u)) {
      const fields = line.trim().split(/\s+/);
      const name = fields[2];
      const ioMilliseconds = fields[12];
      if (!name || !ioMilliseconds || /^(loop|ram|zram|fd|sr)/.test(name)) {
        continue;
      }
      devices.set(name, Number(ioMilliseconds));
    }
    const previous = this.previousDiskStats;
    this.previousDiskStats = { timestamp, devices };
    if (!previous || timestamp <= previous.timestamp) {
      return 100;
    }
    const elapsed = timestamp - previous.timestamp;
    const utilization = [...devices].flatMap(([name, current]) => {
      const before = previous.devices.get(name);
      return before === undefined ? [] : [Math.max(0, (100 * (current - before)) / elapsed)];
    });
    return utilization.length > 0 ? Math.min(100, Math.max(...utilization)) : null;
  }

  private async checkWorkers() {
    let isPresent: boolean;
    try {
      const suffix = `:w:${ImmichWorker.Microservices}`;
      const workers = await this.getQueue(QueueName.BackgroundTask).getWorkers();
      isPresent = workers.some((worker) => worker.rawname?.endsWith(suffix));
    } catch {
      return;
    }

    if (this.microservicesPresent !== isPresent) {
      if (isPresent) {
        this.logger.log('Microservices worker connected.');
      } else {
        this.logger.warn(
          'No microservices worker is connected. Background jobs will not be processed until one is running.',
        );
      }
    }
    this.microservicesPresent = isPresent;
  }

  async run({ name, data }: JobItem) {
    const item = this.handlers[name as JobName];
    if (!item) {
      this.logger.warn(`Skipping unknown job: "${name}"`);
      return JobStatus.Skipped;
    }

    return item.handler(data);
  }

  setConcurrency(queueName: QueueName, concurrency: number) {
    const worker = this.workers[queueName];
    if (!worker) {
      this.logger.warn(`Unable to set queue concurrency, worker not found: '${queueName}'`);
      return;
    }

    worker.concurrency = concurrency;
  }

  async isActive(name: QueueName): Promise<boolean> {
    const queue = this.getQueue(name);
    const count = await queue.getActiveCount();
    return count > 0;
  }

  async isPaused(name: QueueName): Promise<boolean> {
    return this.getQueue(name).isPaused();
  }

  pause(name: QueueName) {
    return this.getQueue(name).pause();
  }

  resume(name: QueueName) {
    return this.getQueue(name).resume();
  }

  empty(name: QueueName) {
    return this.getQueue(name).drain();
  }

  clear(name: QueueName, type: QueueCleanType) {
    return this.getQueue(name).clean(0, 1000, type);
  }

  getJobCounts(name: QueueName): Promise<JobCounts> {
    return this.getQueue(name).getJobCounts(
      'active',
      'completed',
      'failed',
      'delayed',
      'waiting',
      'paused',
    ) as unknown as Promise<JobCounts>;
  }

  private getQueueName(name: JobName) {
    return (this.handlers[name] as JobMapItem).queueName;
  }

  async queueAll(items: JobItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const metadataItems = items.filter((item) => item.name === JobName.AssetExtractMetadata);
    const taskItems = items.filter((item) => getAssetTaskName(item));
    let assetJobRepository: AssetJobRepository | undefined;
    if (metadataItems.length > 0 || taskItems.length > 0) {
      const metadataTaskRepository = this.moduleRef.get(AssetJobRepository, { strict: false });
      assetJobRepository = metadataTaskRepository;
    }
    if (metadataItems.length > 0) {
      const metadataTaskRepository = assetJobRepository!;
      const accepted = new Set<JobItem>();
      for (const force of [false, true]) {
        const group = metadataItems.filter((item) => item.data.force === force);
        if (group.length === 0) {
          continue;
        }
        const acceptedIds = new Set(
          await metadataTaskRepository.queueMetadataTasks(
            group.map((item) => item.data.id),
            force,
          ),
        );
        for (const item of group) {
          if (acceptedIds.has(item.data.id)) {
            accepted.add(item);
          }
        }
      }
      items = items.filter((item) => item.name !== JobName.AssetExtractMetadata || accepted.has(item));
      if (items.length === 0) {
        return;
      }
    }

    if (taskItems.length > 0) {
      const repository = assetJobRepository!;
      const itemsByTask = new Map<ForkAssetTaskName, string[]>();
      for (const item of taskItems) {
        const taskName = getAssetTaskName(item);
        const assetId = getAssetTaskId(item);
        if (!taskName || !assetId) {
          continue;
        }
        const ids = itemsByTask.get(taskName) ?? [];
        ids.push(assetId);
        itemsByTask.set(taskName, ids);
      }
      await Promise.all([...itemsByTask].map(([taskName, ids]) => repository.queueAssetTasks(taskName, ids)));
    }

    const promises = [];
    const itemsByQueue = {} as Record<string, (JobItem & { data: any; options: JobsOptions | undefined })[]>;
    for (const item of items) {
      const queueName = this.getQueueName(item.name);
      const job = {
        name: item.name,
        data: item.data || {},
        options: this.getJobOptions(item) || undefined,
      } as JobItem & { data: any; options: JobsOptions | undefined };

      if (job.options?.jobId || job.options?.deduplication) {
        // need to use add() instead of addBulk() for jobId/deduplication to take effect
        promises.push(this.getQueue(queueName).add(item.name, item.data, job.options));
      } else {
        itemsByQueue[queueName] ||= [];
        itemsByQueue[queueName].push(job);
      }
    }

    for (const [queueName, jobs] of Object.entries(itemsByQueue)) {
      const queue = this.getQueue(queueName as QueueName);
      promises.push(queue.addBulk(jobs));
    }

    try {
      await Promise.all(promises);
    } catch (error) {
      if (assetJobRepository) {
        const repository = assetJobRepository;
        await Promise.allSettled(
          items.flatMap((item) => {
            if (item.name === JobName.AssetExtractMetadata) {
              return [repository.failMetadataTask(item.data.id, error)];
            }
            const taskName = getAssetTaskName(item);
            const assetId = getAssetTaskId(item);
            return taskName && assetId ? [repository.failAssetTask(assetId, taskName, error)] : [];
          }),
        );
      }
      throw error;
    }
  }

  async queue(item: JobItem): Promise<void> {
    return this.queueAll([item]);
  }

  async waitForQueueCompletion(...queues: QueueName[]): Promise<void> {
    const getPending = async () => {
      const results = await Promise.all(queues.map(async (name) => ({ pending: await this.isActive(name), name })));
      return results.filter(({ pending }) => pending).map(({ name }) => name);
    };

    let pending = await getPending();

    while (pending.length > 0) {
      this.logger.verbose(`Waiting for ${pending[0]} queue to stop...`);
      await setTimeout(1000);
      pending = await getPending();
    }
  }

  async searchJobs(name: QueueName, dto: QueueJobSearchDto): Promise<QueueJobResponseDto[]> {
    const jobs = await this.getQueue(name).getJobs(dto.status ?? Object.values(QueueJobStatus), 0, 1000);
    return jobs.map((job) => {
      const { id, name, timestamp, data } = job;
      return { id, name: name as JobName, timestamp, data };
    });
  }

  private getJobOptions(item: JobItem): JobsOptions | null {
    switch (item.name) {
      case JobName.NotifyAlbumUpdate: {
        return {
          jobId: `${item.data.id}/${item.data.recipientId}`,
          delay: item.data?.delay,
        };
      }
      case JobName.StorageTemplateMigrationSingle: {
        return { jobId: item.data.id };
      }
      case JobName.AssetStackRawPair: {
        return { jobId: item.data.assetId };
      }
      case JobName.PersonGenerateThumbnail: {
        return { priority: 1 };
      }
      case JobName.AssetExtractMetadata: {
        return {
          jobId: item.data.id,
          priority: item.data.assetType === AssetType.Video ? 2 : 1,
        };
      }
      case JobName.FacialRecognitionQueueAll: {
        return { deduplication: { id: JobName.FacialRecognitionQueueAll } };
      }
      case JobName.VersionCheck: {
        return { deduplication: { id: JobName.VersionCheck } };
      }
      case JobName.DatabaseBackup: {
        return { deduplication: { id: JobName.DatabaseBackup } };
      }
      default: {
        return null;
      }
    }
  }

  private getQueue(queue: QueueName): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(queue), { strict: false });
  }

  /** @deprecated */
  // todo: remove this when asset notifications no longer need it.
  public async removeJob(name: JobName, jobID: string): Promise<void> {
    const queues =
      name === JobName.AssetExtractMetadata
        ? [QueueName.MetadataExtraction, QueueName.VideoMetadataExtraction]
        : [this.getQueueName(name)];
    for (const queueName of queues) {
      const existingJob = await this.getQueue(queueName).getJob(jobID);
      if (existingJob) {
        await existingJob.remove();
        return;
      }
    }
  }
}
