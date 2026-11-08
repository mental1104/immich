/**
 * 为既有关联固定不可变底稿并逐项验证原始手机版本；只处理显式配置库内已被引用的来源。
 * protect --apply REPORT [LIMIT] [AFTER]，LIMIT 为 1..1000，报告必须是新建私有文件。
 * 不启动 API 或迁移，不清理任何文件，不自动恢复队列或手机备份。
 */
import { Kysely } from 'kysely';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { IphoneBackupSourceService } from 'src/services/iphone-backup-source.service.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { getIphoneBackupConfig } from 'src/utils/iphone-backup.js';

/** @returns 有界保护结果；任一失败停止，保留已完成报告，不跳过坏配方继续清理。 */
async function main(): Promise<void> {
  const [command, apply, report, count = '100', after] = process.argv.slice(2);
  const limit = Number(count);
  if (
    command !== 'protect' ||
    apply !== '--apply' ||
    !report ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new Error('Usage: protect --apply REPORT [LIMIT] [AFTER]');
  }
  if (after) z.uuid().parse(after);
  const backup = getIphoneBackupConfig();
  if (!backup || !process.env.IMMICH_FORK_IPHONE_BACKUP_SNAPSHOT_ROOT)
    throw new Error('Snapshot protection is not configured');
  const output = await open(report, 'wx', 0o600);
  const config = new ConfigRepository();
  const db = new Kysely<DB>(getKyselyConfig(config.getEnv().database.config));
  const metadata = new MetadataRepository(LoggingRepository.create());
  const service = new IphoneBackupSourceService(db, metadata);
  let protectedSources = 0;
  let protectedReferences = 0;
  let lastId: string | undefined;
  try {
    const rows = await db
      .selectFrom('asset as source')
      .innerJoin('library', 'library.id', 'source.libraryId')
      .select('source.id')
      .where('source.libraryId', '=', backup.libraryId)
      .whereRef('source.ownerId', '=', 'library.ownerId')
      .where('library.deletedAt', 'is', null)
      .where('source.deletedAt', 'is', null)
      .where('source.isOffline', '=', false)
      .where('source.backupChecksum', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset as version')
            .select('version.id')
            .whereRef('version.backupSourceId', '=', 'source.id')
            .where('version.deletedAt', 'is', null),
        ),
      )
      .$if(!!after, (query) => query.where('source.id', '>', after!))
      .orderBy('source.id')
      .limit(limit)
      .execute();
    for (const source of rows) {
      const result = await service.refreshSource(source.id);
      await output.writeFile(JSON.stringify(result) + '\n');
      await output.sync();
      if (result.invalidReferences > 0) throw new Error('Unrecoverable legacy reference');
      protectedSources++;
      protectedReferences += result.restoredReferences + result.retainedReferences;
      lastId = source.id;
    }
    console.info(JSON.stringify({ protectedSources, protectedReferences, lastId }));
  } finally {
    await output.close();
    await metadata.teardown();
    await db.destroy();
  }
}

void main().catch(() => {
  console.error('Backup snapshot protection failed; queue state unchanged');
  process.exitCode = 1;
});
