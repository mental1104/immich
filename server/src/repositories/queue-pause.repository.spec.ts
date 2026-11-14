import { getQueueToken } from '@nestjs/bullmq';
import { ModuleRef } from '@nestjs/core';
import type { Mock } from 'vitest';
import { QueueName } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PIPELINE_QUEUES, QueuePauseRepository } from 'src/repositories/queue-pause.repository.js';

/** 使用原生队列边界替身验证时间和重启语义；真实 Valkey 行为另在隔离 HTTP 验收中验证。 */
describe('photo pipeline pause deadlines', () => {
  const records = new Map<string, string>();
  const queues = new Map<
    string,
    { pause: Mock<() => Promise<void>>; resume: Mock<() => Promise<void>>; isPaused: Mock<() => Promise<boolean>> }
  >();
  const client = {
    hget: vi.fn((_key: string, name: string) => Promise.resolve(records.get(name) ?? null)),
    hset: vi.fn((_key: string, name: string, value: string) => Promise.resolve(records.set(name, value))),
    hdel: vi.fn((_key: string, name: string) => Promise.resolve(records.delete(name))),
  };
  const database = { withLock: vi.fn(async (_lock: number, callback: () => Promise<unknown>) => callback()) };
  const moduleRef = {
    get: vi.fn((token: string) => {
      if (token === getQueueToken(QueueName.BackgroundTask)) {
        return { getBackend: () => ({ client }) };
      }
      return queues.get(token);
    }),
  };
  const logger = { setContext: vi.fn(), log: vi.fn(), error: vi.fn() };

  /** @returns 新进程持有的控制器；Redis 和原生队列状态在多个实例间共享。 */
  const create = () =>
    new QueuePauseRepository(
      moduleRef as unknown as ModuleRef,
      database as unknown as DatabaseRepository,
      logger as unknown as LoggingRepository,
    );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.stubEnv('IMMICH_FORK_PIPELINE_AUTO_RESUME', 'true');
    vi.stubEnv('IMMICH_FORK_PIPELINE_PAUSE_MS', '900000');
    records.clear();
    queues.clear();
    for (const name of PIPELINE_QUEUES) {
      let paused = false;
      queues.set(getQueueToken(name), {
        pause: vi.fn(() => {
          paused = true;
          return Promise.resolve();
        }),
        resume: vi.fn(() => {
          paused = false;
          return Promise.resolve();
        }),
        isPaused: vi.fn(() => Promise.resolve(paused)),
      });
    }
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /** 15 分钟前保持暂停，重建控制器后仍按原期限恢复，不重置计时。 */
  it('resumes at the original deadline after a process restart', async () => {
    await create().pause(QueueName.Ocr, 'temporary');
    vi.setSystemTime(1_899_999);
    await create().reconcile();
    expect(await queues.get(getQueueToken(QueueName.Ocr))!.isPaused()).toBe(true);
    vi.setSystemTime(1_900_000);
    await create().reconcile();
    expect(await queues.get(getQueueToken(QueueName.Ocr))!.isPaused()).toBe(false);
    expect(records.has(QueueName.Ocr)).toBe(false);
  });

  /** 内部维护覆盖旧临时期限，过期核对不会提前恢复。 */
  it('preserves an explicit maintenance pause and excludes offline conversion', async () => {
    await create().pause(QueueName.MetadataExtraction, 'temporary');
    await create().pause(QueueName.MetadataExtraction);
    vi.setSystemTime(3_000_000);
    await create().reconcile();
    expect(await queues.get(getQueueToken(QueueName.MetadataExtraction))!.isPaused()).toBe(true);
    expect(PIPELINE_QUEUES.has(QueueName.VideoConversion)).toBe(false);
    await expect(create().command(QueueName.VideoConversion, 'resume')).rejects.toThrow('photo pipeline');
  });

  /** 新暂停延长期限；手动恢复清除元数据，避免旧期限影响下一轮维护。 */
  it('honors renewed deadlines and clears a manually resumed pause', async () => {
    const repository = create();
    await repository.pause(QueueName.Ocr, 'temporary');
    vi.setSystemTime(1_500_000);
    await repository.pause(QueueName.Ocr, 'temporary');
    vi.setSystemTime(1_900_001);
    await repository.reconcile();
    expect(await queues.get(getQueueToken(QueueName.Ocr))!.isPaused()).toBe(true);
    await repository.resume(QueueName.Ocr);
    expect(records.has(QueueName.Ocr)).toBe(false);
  });

  /** 启用功能只收养未登记历史暂停；关闭功能不改变已有 API 的无限期暂停语义。 */
  it('adopts legacy pauses while keeping the feature opt in', async () => {
    await queues.get(getQueueToken(QueueName.Ocr))!.pause();
    await create().reconcile();
    expect(JSON.parse(records.get(QueueName.Ocr)!)).toMatchObject({ mode: 'temporary', resumeAt: 1_900_000 });
    vi.stubEnv('IMMICH_FORK_PIPELINE_AUTO_RESUME', 'false');
    await create().pause(QueueName.Ocr, 'temporary');
    vi.setSystemTime(9_000_000);
    await create().reconcile();
    expect(await queues.get(getQueueToken(QueueName.Ocr))!.isPaused()).toBe(true);
  });
});
