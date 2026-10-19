import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "fork_geodata_name" (
    "geonameId" integer NOT NULL,
    "kind" text NOT NULL,
    "scope" text NOT NULL,
    "name" text NOT NULL,
    "country" text NOT NULL,
    "state" text,
    "localizedName" text NOT NULL,
    "aliases" text[] NOT NULL,
    CONSTRAINT "fork_geodata_name_pkey" PRIMARY KEY ("geonameId", "kind")
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('fork_geodata_name').execute();
}
