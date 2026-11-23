import { Kysely, sql } from 'kysely';

/** @param db 目标库。@returns 仅创建个人搜索登记表，不修改旧资产或分组。 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "fork_search_preset" (
  "id" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "name" text NOT NULL,
  "conditions" jsonb NOT NULL,
  CONSTRAINT "fork_search_preset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "fork_search_preset_userId_name_uq" UNIQUE ("userId", "name"),
  CONSTRAINT "fork_search_preset_pkey" PRIMARY KEY ("id")
);`.execute(db);
}

/** @param db 回退库。@returns 删除个人登记数据，其他表保持原样。 */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "fork_search_preset";`.execute(db);
}
