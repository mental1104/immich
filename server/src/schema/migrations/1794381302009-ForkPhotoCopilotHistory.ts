import { Kysely, sql } from 'kysely';

/** @param db 迁移事务。只创建 Photo Copilot 的会话、消息及对应索引。 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "fork_photo_copilot_session" (
  "id" uuid NOT NULL,
  "ownerId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'idle',
  "messageCount" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "fork_photo_copilot_session_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "fork_photo_copilot_session_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "fork_photo_copilot_session_status_chk" CHECK (status IN ('idle', 'starting', 'completed', 'interrupted', 'failed')),
  CONSTRAINT "fork_photo_copilot_session_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "fork_photo_copilot_session_ownerId_assetId_updatedAt_idx" ON "fork_photo_copilot_session" ("ownerId", "assetId", "updatedAt");`.execute(db);
  await sql`CREATE INDEX "fork_photo_copilot_session_assetId_idx" ON "fork_photo_copilot_session" ("assetId");`.execute(db);
  await sql`CREATE TABLE "fork_photo_copilot_message" (
  "sessionId" uuid NOT NULL,
  "position" integer NOT NULL,
  "id" uuid NOT NULL,
  "role" text NOT NULL,
  "text" text NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "fork_photo_copilot_message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "fork_photo_copilot_session" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "fork_photo_copilot_message_role_chk" CHECK (role IN ('user', 'assistant')),
  CONSTRAINT "fork_photo_copilot_message_pkey" PRIMARY KEY ("sessionId", "position")
);`.execute(db);
}

/** @param db 迁移事务。删除本功能表及其记录，保留图库资产。 */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "fork_photo_copilot_message";`.execute(db);
  await sql`DROP TABLE "fork_photo_copilot_session";`.execute(db);
}
