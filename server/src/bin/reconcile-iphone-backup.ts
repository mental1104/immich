/**
 * 显式管理历史 JPEG/PNG 的可恢复引用，不启动 API、任务消费或迁移，不改动 Live Photo 的视频关联。
 * assess <report> [limit] [after] 只读；prepare --apply <report> 建立关联但不删文件；
 * cleanup --apply <report> <sessionId> 仅在手机确认同步后移除报告内的已匹配暂存原片；
 * restore --apply <report> 无损恢复文件并撤销引用，用于回退。
 * 报告保存在私有目录，stdout 只输出数量；不修改其他用户、库或 NAS 原片。
 */
import { Kysely } from 'kysely';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import {
  IphoneBackupReferenceAssessment,
  IphoneBackupReferenceService,
} from 'src/services/iphone-backup-reference.service.js';
import { getKyselyConfig } from 'src/utils/database.js';

const reportSchema = z.array(
  z.object({
    id: z.uuid(),
    status: z.enum(['matched', 'unmatched', 'unsupported', 'conflict', 'unsafe']),
    plan: z
      .object({
        versionId: z.uuid(),
        sourceId: z.uuid(),
        stagedPath: z.string(),
        sourcePath: z.string(),
        versionChecksum: z.string().regex(/^[a-f\d]{40}$/),
        sourceChecksum: z.string().regex(/^[a-f\d]{40}$/),
        image: z.string().min(64),
        metadata: z.string().regex(/^[a-f\d]{64}$/),
      })
      .optional(),
  }),
);

/**
 * 运行明确选择的一个阶段；写入操作必须带 --apply，执行结果逐项保存以便崩溃后恢复。
 * @returns 阶段完成；任一项失败会设置非零退出码并保留已完成项，绝不自动跳过清理保护。
 */
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const apply = args[0] === '--apply';
  if (apply) args.shift();
  const [report, argument, after] = args;
  if (!report || !['assess', 'prepare', 'cleanup', 'restore'].includes(command) || (command !== 'assess' && !apply)) {
    throw new Error('Usage: assess REPORT [LIMIT] [AFTER] | prepare --apply REPORT | cleanup --apply REPORT SESSION');
  }
  const config = new ConfigRepository();
  const db = new Kysely<DB>(getKyselyConfig(config.getEnv().database.config));
  const metadata = new MetadataRepository(LoggingRepository.create());
  const service = new IphoneBackupReferenceService(db, metadata);
  try {
    if (command === 'assess') {
      if (after) z.uuid().parse(after);
      const rows = await service.assess(argument === undefined ? 100 : Number(argument), after);
      await writeFile(report, JSON.stringify(rows, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      const counts: Record<string, number> = {};
      for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
      console.info(JSON.stringify({ command, counts, lastId: rows.at(-1)?.id }));
      return;
    }
    const rows: IphoneBackupReferenceAssessment[] = reportSchema.parse(JSON.parse(await readFile(report, 'utf8')));
    if (command === 'cleanup') z.uuid().parse(argument);
    const results: { id: string; status: string }[] = [];
    for (const row of rows) {
      if (row.status !== 'matched' || !row.plan) continue;
      try {
        if (row.id !== row.plan.versionId) throw new Error('Report identity mismatch');
        if (command === 'prepare') {
          await service.prepare(row.plan);
          results.push({ id: row.id, status: 'prepared' });
        } else if (command === 'restore') {
          results.push({ id: row.id, status: await service.restore(row.id) });
        } else {
          results.push({ id: row.id, status: await service.cleanup(row.id, argument) });
        }
      } catch {
        results.push({ id: row.id, status: 'blocked' });
        process.exitCode = 1;
      }
      // 每完成一项就记录结果；重试时 prepare/cleanup 都保持幂等。
      await writeFile(`${report}.${command}.json`, JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
    }
    console.info(
      JSON.stringify({
        command,
        total: results.length,
        blocked: results.filter((row) => row.status === 'blocked').length,
      }),
    );
  } finally {
    await metadata.teardown();
    await db.destroy();
  }
}

void main().catch(() => {
  // 不向共享日志输出私人路径、照片文件名、凭据或文件哈希。
  console.error('Backup reference command failed; no automatic cleanup will be attempted');
  process.exitCode = 1;
});
