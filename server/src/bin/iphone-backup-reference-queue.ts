/**
 * 检查或控制显式启用的备份关联队列，不启动 API、消费者、迁移或文件清理。
 * 输入：status | pause --apply | resume --apply | retry --apply JOB_ID。
 * 输出：计数、暂停状态和有限失败任务 ID；不输出私人路径、内容哈希、EXIF 或原始错误。
 * 写操作只影响本 Fork 的独立队列，不能清空任务或重置客户端同步。
 */
import { Queue } from 'bullmq';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { IPHONE_REFERENCE_QUEUE } from 'src/services/iphone-backup-reconciliation.service.js';
import { getIphoneBackupConfig } from 'src/utils/iphone-backup.js';

/** @returns 执行一个明确命令并关闭 Redis 连接；错误只对外报告固定状态，不泄露底层连接信息。 */
async function main(): Promise<void> {
  const [command = 'status', apply, id] = process.argv.slice(2);
  if (!getIphoneBackupConfig() || !['status', 'pause', 'resume', 'retry'].includes(command)) {
    throw new Error('Invalid reference queue command');
  }
  if (command !== 'status' && apply !== '--apply') throw new Error('Queue changes require --apply');
  const queue = new Queue(IPHONE_REFERENCE_QUEUE, new ConfigRepository().getEnv().bull.config);
  queue.on('error', () => console.error('Reference queue connection failed'));
  try {
    switch (command) {
      case 'pause': {
        await queue.pause();
        break;
      }
      case 'resume': {
        await queue.resume();
        break;
      }
      case 'retry': {
        if (
          !id ||
          !/^(?:(?:match|cleanup)-[a-f\d-]+(?:-(?:clip|time))?|(?:index|refresh)-[a-f\d-]+-[a-f\d]{64})$/.test(id)
        )
          throw new Error('Invalid reference job ID');
        const job = await queue.getJob(id);
        if (!job || (await job.getState()) !== 'failed') throw new Error('No failed reference job to retry');
        await job.retry('failed');

        break;
      }
      // No default
    }
    const counts = await queue.getJobCounts();
    const failed = await queue.getJobs(['failed'], 0, 19);
    console.info(JSON.stringify({ paused: await queue.isPaused(), counts, failedJobIds: failed.map((job) => job.id) }));
  } finally {
    await queue.close();
  }
}

void main().catch(() => {
  console.error('Reference queue command failed');
  process.exitCode = 1;
});
