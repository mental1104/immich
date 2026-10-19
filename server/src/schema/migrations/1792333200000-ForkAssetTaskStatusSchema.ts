import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "fork_asset_task_status" ALTER COLUMN "createdAt" SET DEFAULT now(), ALTER COLUMN "updatedAt" SET DEFAULT now();`.execute(
    db,
  );
  await sql`CREATE INDEX "fork_asset_task_status_assetId_idx" ON "fork_asset_task_status" ("assetId");`.execute(db);
  await sql`ALTER TABLE "fork_asset_task_status" DROP CONSTRAINT "fork_asset_task_status_status_check";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "fork_asset_task_status" ALTER COLUMN "createdAt" SET DEFAULT clock_timestamp(), ALTER COLUMN "updatedAt" SET DEFAULT clock_timestamp();`.execute(
    db,
  );
  await sql`DROP INDEX "fork_asset_task_status_assetId_idx";`.execute(db);
  await sql`ALTER TABLE "fork_asset_task_status" ADD CONSTRAINT "fork_asset_task_status_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed'));`.execute(
    db,
  );
}
