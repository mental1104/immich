import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "album_tag" (
    "albumId" uuid NOT NULL REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "tagId" uuid NOT NULL REFERENCES "tag" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "album_tag_pkey" PRIMARY KEY ("albumId", "tagId")
  );`.execute(db);
  await sql`CREATE INDEX "album_tag_tagId_idx" ON "album_tag" ("tagId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "album_tag";`.execute(db);
}
