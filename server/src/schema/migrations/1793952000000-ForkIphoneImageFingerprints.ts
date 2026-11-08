import { Kysely, sql } from 'kysely';

/**
 * 新增可重建的图像本体索引和不可由公开元数据 API 改写的上传来源。
 * @param db 迁移事务连接；仅创建新表和索引，不修改已有资产、客户端映射或原片。
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "fork_iphone_image_fingerprint" (
    "assetId" uuid NOT NULL REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "fileChecksum" bytea NOT NULL,
    "imageFingerprint" text NOT NULL,
    "signature" text NOT NULL,
    "format" text NOT NULL,
    CONSTRAINT "fork_iphone_image_fingerprint_pkey" PRIMARY KEY ("assetId")
  )`.execute(db);
  await sql`CREATE INDEX "fork_iphone_image_fingerprint_imageFingerprint_idx"
    ON "fork_iphone_image_fingerprint" ("imageFingerprint")`.execute(db);
  await sql`CREATE TABLE "fork_iphone_upload_origin" (
    "assetId" uuid NOT NULL REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "originalPath" character varying NOT NULL,
    "checksum" bytea NOT NULL,
    "recovery" bytea,
    "snapshot" jsonb NOT NULL,
    "recoveredAssetId" uuid,
    CONSTRAINT "fork_iphone_upload_origin_pkey" PRIMARY KEY ("assetId")
  )`.execute(db);
  await sql`CREATE TABLE "fork_iphone_source_snapshot" (
    "sourceId" uuid NOT NULL REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "checksum" bytea NOT NULL,
    "path" character varying NOT NULL,
    "signature" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "fork_iphone_source_snapshot_pkey" PRIMARY KEY ("sourceId", "checksum")
  )`.execute(db);
}

/**
 * 只允许在上传原始恢复资料已另行处理后回退，防止把真实版本资料当成可重建缓存删除。
 * @param db 迁移事务连接；存在来源记录时整笔回退失败，不删除任何表或原片。
 */
export async function down(db: Kysely<any>): Promise<void> {
  const { rows } = await sql<{ exists: boolean }>`SELECT EXISTS(SELECT 1 FROM "fork_iphone_upload_origin")`.execute(db);
  if (rows[0].exists) throw new Error('Preserve upload origin recovery records before rollback');
  const snapshots = await sql<{ exists: boolean }>`SELECT EXISTS(SELECT 1 FROM "fork_iphone_source_snapshot")`.execute(db);
  if (snapshots.rows[0].exists) throw new Error('Preserve source snapshot records before rollback');
  await sql`DROP TABLE "fork_iphone_source_snapshot"`.execute(db);
  await sql`DROP TABLE "fork_iphone_upload_origin"`.execute(db);
  await sql`DROP TABLE "fork_iphone_image_fingerprint"`.execute(db);
}
