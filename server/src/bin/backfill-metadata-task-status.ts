import { Kysely } from 'kysely';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DB } from 'src/schema/index.js';
import { ForkAssetTask, ForkAssetTaskState } from 'src/schema/tables/fork-asset-task-status.table.js';
import { getKyselyConfig } from 'src/utils/database.js';

const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10_000;

const parseBatchSize = (value: string | undefined): number => {
  if (value === undefined) {
    return DEFAULT_BATCH_SIZE;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new Error(`Batch size must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
  return parsed;
};

const main = async () => {
  const batchSize = parseBatchSize(process.argv[2]);
  const { database } = new ConfigRepository().getEnv();
  const db = new Kysely<DB>(getKyselyConfig(database.config));
  let cursor: string | undefined;
  let inserted = 0;
  let scanned = 0;

  try {
    while (true) {
      const query = db
        .selectFrom('asset_job_status')
        .select(['assetId', 'metadataExtractedAt'])
        .where('metadataExtractedAt', 'is not', null)
        .orderBy('assetId')
        .limit(batchSize);
      const rows = await (cursor ? query.where('assetId', '>', cursor) : query).execute();
      if (rows.length === 0) {
        break;
      }

      const result = await db
        .insertInto('fork_asset_task_status')
        .values(
          rows.map((row) => ({
            assetId: row.assetId,
            taskName: ForkAssetTask.MetadataExtraction,
            status: ForkAssetTaskState.Completed,
            attempts: 1,
            completedAt: row.metadataExtractedAt!,
          })),
        )
        .onConflict((oc) => oc.columns(['assetId', 'taskName']).doNothing())
        .returning('assetId')
        .execute();

      scanned += rows.length;
      inserted += result.length;
      cursor = rows.at(-1)!.assetId;
      console.info(`Scanned ${scanned} successful metadata records; added ${inserted} task states`);
    }
  } finally {
    await db.destroy();
  }

  console.info(`Metadata task-state backfill complete: scanned ${scanned}, added ${inserted}`);
};

main().catch((error: unknown) => {
  console.error('Metadata task-state backfill failed:', error);
  process.exitCode = 1;
});
