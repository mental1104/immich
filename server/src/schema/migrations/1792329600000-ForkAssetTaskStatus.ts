import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE "fork_asset_task_status" (
      "assetId" uuid NOT NULL,
      "taskName" character varying NOT NULL,
      "status" character varying NOT NULL,
      "attempts" integer NOT NULL DEFAULT 0,
      "generation" integer NOT NULL DEFAULT 1,
      "queuedAt" timestamp with time zone,
      "startedAt" timestamp with time zone,
      "completedAt" timestamp with time zone,
      "failedAt" timestamp with time zone,
      "errorMessage" text,
      "createdAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
      "updatedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT "fork_asset_task_status_pkey" PRIMARY KEY ("assetId", "taskName"),
      CONSTRAINT "fork_asset_task_status_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "fork_asset_task_status_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed'))
    );
  `.execute(db);
  await sql`CREATE INDEX "fork_asset_task_status_taskName_status_idx" ON "fork_asset_task_status" ("taskName", "status");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "fork_asset_task_status";`.execute(db);
}
