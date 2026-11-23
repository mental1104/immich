import { Kysely, sql } from 'kysely';

/** @param db 目标数据库。@returns 仅创建可选大组和个人分组归属表，不回填旧相簿。 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "fork_album_category" (
  "id" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "name" text NOT NULL,
  CONSTRAINT "fork_album_category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "fork_album_category_userId_name_uq" UNIQUE ("userId", "name"),
  CONSTRAINT "fork_album_category_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE TABLE "fork_album_group_category" (
  "userId" uuid NOT NULL,
  "groupName" text NOT NULL,
  "categoryId" uuid NOT NULL,
  CONSTRAINT "fork_album_group_category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "fork_album_group_category_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "fork_album_category" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "fork_album_group_category_pkey" PRIMARY KEY ("userId", "groupName")
);`.execute(db);
  await sql`CREATE INDEX "fork_album_group_category_categoryId_idx" ON "fork_album_group_category" ("categoryId");`.execute(db);
}

/** @param db 回退数据库。@returns 删除本次两张目录表，既有相簿分组与资产关系保持。 */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "fork_album_group_category";`.execute(db);
  await sql`DROP TABLE "fork_album_category";`.execute(db);
}
