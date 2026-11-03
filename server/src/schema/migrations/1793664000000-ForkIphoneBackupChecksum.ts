import { Kysely, sql } from 'kysely';

/**
 * 增加可空内容指纹，不读取或修改任何原片；已有资产由后续显式库扫描补算。
 * @param db 当前迁移事务的数据库连接。
 * @returns 字段及查询索引创建完成；SQL 失败时由迁移器回滚。
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset" ADD COLUMN "contentChecksum" bytea;`.execute(db);
  await sql`CREATE INDEX "fork_asset_content_checksum_idx" ON "asset" ("ownerId", "contentChecksum") WHERE "contentChecksum" IS NOT NULL;`.execute(db);
}

/**
 * 回退内容指纹结构；原有路径标识与照片文件均保留。
 * @param db 当前迁移事务的数据库连接。
 * @returns 新索引及字段删除完成；不回退已明确执行的文件归档。
 */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "fork_asset_content_checksum_idx";`.execute(db);
  await sql`ALTER TABLE "asset" DROP COLUMN "contentChecksum";`.execute(db);
}
