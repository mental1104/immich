import { Kysely, sql } from 'kysely';

/** @param db 迁移事务。添加工作台版本索引，保留图库数据和旧迁移。 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "fork_photo_edit_version" (
    "id" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "assetName" text NOT NULL,
    "parentId" uuid,
    "kind" text NOT NULL,
    "editor" text,
    "filename" text NOT NULL,
    "extension" text NOT NULL,
    "note" text NOT NULL,
    "state" text NOT NULL DEFAULT 'pending',
    "committedAt" timestamp with time zone,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "fork_photo_edit_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fork_photo_edit_version_kind_chk" CHECK (kind IN ('codex', 'upload')),
    CONSTRAINT "fork_photo_edit_version_state_chk" CHECK (state IN ('pending', 'ready', 'failed'))
  );`.execute(db);
  await sql`CREATE INDEX "fork_photo_edit_version_ownerId_assetId_createdAt_idx"
    ON "fork_photo_edit_version" ("ownerId", "assetId", "createdAt");`.execute(db);
}

/** @param db 迁移事务。删除工作台索引，原生资产和磁盘文件由各自的生命周期保留。 */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "fork_photo_edit_version";`.execute(db);
}
