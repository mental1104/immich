import { Kysely, sql } from 'kysely';

/**
 * 注册部分索引的规范 SQL，使 sql-tools 按与代码相同的定义比较数据库结构。
 * @param db 当前迁移事务连接；只写本功能的 migration_overrides 记录。
 * @returns 描述记录写入完成；不重建索引、不修改资产或原片。
 */
export async function up(db: Kysely<any>): Promise<void> {
  const value = { type: 'index', name: 'fork_asset_content_checksum_idx', sql: 'CREATE INDEX "fork_asset_content_checksum_idx" ON "asset" ("ownerId", "contentChecksum") WHERE ("contentChecksum" IS NOT NULL);' };
  // 使用 SQL 字面量，避免驱动将已序列化字符串再次编码成 JSON 字符串值。
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_fork_asset_content_checksum_idx', ${sql.lit(JSON.stringify(value))}::jsonb) ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value";`.execute(db);
}

/**
 * 撤销本功能的索引描述，物理索引由前一条迁移负责回退。
 * @param db 当前迁移事务连接。
 * @returns 描述删除完成；不修改任何原片或内容指纹。
 */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_fork_asset_content_checksum_idx';`.execute(db);
}
