import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset" ADD COLUMN is_raw boolean GENERATED ALWAYS AS (lower(right("originalFileName", 4)) IN ('.dng', '.nef')) STORED;`.execute(
    db,
  );
  await sql`CREATE INDEX "asset_is_raw_not_deleted_idx" ON "asset" (is_raw) WHERE is_raw IS TRUE AND "deletedAt" IS NULL;`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "asset_is_raw_not_deleted_idx";`.execute(db);
  await sql`ALTER TABLE "asset" DROP COLUMN is_raw;`.execute(db);
}
