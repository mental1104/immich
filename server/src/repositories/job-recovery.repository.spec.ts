import { AssetType, JobName, QueueName } from 'src/enum.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import type { JobItem } from 'src/types.js';

/** @returns 只替换队列边界的仓库及替身，用于观察 retry/add 的选择。 */
const setup = () => {
  const existing = {
    getState: vi.fn().mockResolvedValue('failed'),
    updateData: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
  };
  const queue = { getJob: vi.fn().mockResolvedValue(existing), add: vi.fn().mockResolvedValue(undefined) };
  const repository = Object.create(JobRepository.prototype) as JobRepository;
  repository['moduleRef'] = { get: vi.fn().mockReturnValue(queue) } as never;
  return { repository, queue, existing };
};

/** 原生 add 的稳定键既要去重活跃任务，也不能吞掉上游发出的新恢复请求。 */
describe('downstream retained job recovery', () => {
  /** 明确的新上游触发可以恢复旧失败，活跃任务仍按原键去重。 */
  it.each([JobName.AssetExtractMetadata, JobName.AssetStackRawPair])('retries retained failed %s', async (name) => {
    const { repository, queue, existing } = setup();
    const item = {
      name,
      data: { id: 'asset-1', assetId: 'asset-1', assetType: AssetType.Image, force: true },
    } as JobItem;
    await repository['addWithRecovery'](QueueName.MetadataExtraction, item, { jobId: 'asset-1' });
    expect(existing.updateData).toHaveBeenCalledWith(item.data);
    expect(existing.retry).toHaveBeenCalledWith('failed');
    expect(queue.add).not.toHaveBeenCalled();
  });

  /** 两个恢复请求竞速时，已经恢复为 active 的状态视为成功，不重复创建任务。 */
  it('coalesces a concurrent native retry', async () => {
    const { repository, queue, existing } = setup();
    existing.getState.mockResolvedValueOnce('failed').mockResolvedValueOnce('active');
    existing.retry.mockRejectedValue(new Error('Job is not in failed state'));
    await repository['addWithRecovery'](
      QueueName.MetadataExtraction,
      { name: JobName.AssetExtractMetadata, data: { id: 'asset-1' } },
      { jobId: 'asset-1' },
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  /** 竞争者已完成并删除任务时，本次恢复至多再创建一次，不进入轮询补队循环。 */
  it('recreates once if a competing worker already completed and removed the retained job', async () => {
    const { repository, queue, existing } = setup();
    existing.getState.mockResolvedValueOnce('failed').mockResolvedValueOnce('unknown');
    existing.updateData.mockRejectedValue(new Error('Missing key for job'));
    const item: JobItem = { name: JobName.AssetExtractMetadata, data: { id: 'asset-1' } };
    await repository['addWithRecovery'](QueueName.MetadataExtraction, item, { jobId: 'asset-1' });
    expect(queue.add).toHaveBeenCalledExactlyOnceWith(item.name, item.data, { jobId: 'asset-1' });
  });

  /** 真正的队列错误不能被竞速兼容分支吞掉，更不能用无限 add 循环掩盖。 */
  it('propagates a real recovery failure', async () => {
    const { repository, queue, existing } = setup();
    const error = new Error('Queue unavailable');
    existing.retry.mockRejectedValue(error);
    await expect(
      repository['addWithRecovery'](
        QueueName.MetadataExtraction,
        { name: JobName.AssetExtractMetadata, data: { id: 'asset-1' } },
        { jobId: 'asset-1' },
      ),
    ).rejects.toBe(error);
    expect(queue.add).not.toHaveBeenCalled();
  });

  /** 正在执行的任务保持原生去重，不更新其数据或强制移动状态。 */
  it('preserves active job deduplication', async () => {
    const { repository, queue, existing } = setup();
    existing.getState.mockResolvedValue('active');
    const item: JobItem = { name: JobName.AssetExtractMetadata, data: { id: 'asset-1' } };
    await repository['addWithRecovery'](QueueName.MetadataExtraction, item, { jobId: 'asset-1' });
    expect(queue.add).toHaveBeenCalledWith(item.name, item.data, { jobId: 'asset-1' });
    expect(existing.retry).not.toHaveBeenCalled();
    expect(existing.updateData).not.toHaveBeenCalled();
  });
});
