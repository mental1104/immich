import { Kysely, sql } from 'kysely';

/** 本迁移冻结的函数文本；不引用未来可变的 schema 定义。 */
const current = [
  { name: "fork_iphone_client_checksum", sql: `CREATE OR REPLACE FUNCTION fork_iphone_client_checksum()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    DECLARE
      matching_checksum bytea;
      source_asset asset%ROWTYPE;
    BEGIN
      NEW."clientChecksum" := NULL;
      IF NEW."backupChecksum" IS NOT NULL THEN
        IF NEW."backupMetadata" IS NULL THEN
          RAISE EXCEPTION 'Invalid iPhone backup reference';
        END IF;
        IF NEW."backupSourceId" IS NULL THEN
          NEW."isOffline" := true;
          RETURN NEW;
        END IF;
        SELECT * INTO source_asset FROM asset WHERE id = NEW."backupSourceId";
        IF NOT FOUND OR source_asset.id = NEW.id OR source_asset."backupChecksum" IS NOT NULL
          OR source_asset."ownerId" <> NEW."ownerId" OR source_asset."libraryId" IS DISTINCT FROM NEW."libraryId"
          OR NEW."originalPath" <> source_asset."originalPath" THEN
          RAISE EXCEPTION 'Invalid iPhone backup reference';
        END IF;
        IF source_asset."isOffline" OR source_asset."deletedAt" IS NOT NULL
          OR source_asset."contentChecksum" IS NULL OR (
            source_asset."contentChecksum" IS DISTINCT FROM NEW."contentChecksum"
            AND NOT EXISTS (SELECT 1 FROM fork_iphone_source_snapshot s
              WHERE s."sourceId" = source_asset.id AND s.checksum = NEW."contentChecksum")
          ) THEN
          NEW."isOffline" := true;
        END IF;
      ELSIF NEW."backupSourceId" IS NOT NULL THEN
        RAISE EXCEPTION 'Missing iPhone backup matching checksum';
      END IF;
      IF NEW."libraryId" IS NULL OR NEW."contentChecksum" IS NULL
        OR NEW."isOffline" OR NEW."deletedAt" IS NOT NULL THEN
        RETURN NEW;
      END IF;

      -- 分配发生在数据库内，覆盖上传、扫描和独立指纹任务的所有写入入口。
      PERFORM pg_advisory_xact_lock(hashtextextended('fork-iphone-client-checksum:' || NEW."libraryId"::text, 0));
      matching_checksum := coalesce(NEW."backupChecksum", NEW."contentChecksum");
      IF NOT EXISTS (
        SELECT 1 FROM asset AS other
        WHERE other."ownerId" = NEW."ownerId" AND other."libraryId" = NEW."libraryId"
          AND other.id <> NEW.id
          AND (other."clientChecksum" = matching_checksum OR other.checksum = matching_checksum)
      ) THEN
        NEW."clientChecksum" := matching_checksum;
      END IF;
      RETURN NEW;
    END
  $$;` },
  { name: "fork_iphone_reference_state", sql: `CREATE OR REPLACE FUNCTION fork_iphone_reference_state()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    DECLARE
      refresh_proof jsonb;
    BEGIN
      refresh_proof := NULLIF(current_setting('immich.fork_iphone_reference_refresh', true), '')::jsonb;
      -- 只有应用逐字节复原过、绑定当前源及新校验和且已保存底稿的版本才能原子换底稿。
      -- 其余版本保留旧 pin；存在旧底稿时仍能提供完整原文件，不会短暂清空 clientChecksum。
      WITH proposed AS (
        SELECT v.id, CASE WHEN refresh_proof->>'sourceId' = NEW.id::text
          AND refresh_proof->>'checksum' = encode(NEW."contentChecksum", 'hex')
          AND (refresh_proof->'versions') ? v.id::text
          AND v."ownerId" = NEW."ownerId" AND v."libraryId" IS NOT DISTINCT FROM NEW."libraryId"
          AND EXISTS (SELECT 1 FROM fork_iphone_source_snapshot s
            WHERE s."sourceId" = NEW.id AND s.checksum = NEW."contentChecksum")
          THEN NEW."contentChecksum" ELSE v."contentChecksum" END AS pin
        FROM asset v WHERE v."backupSourceId" = NEW.id
      )
      UPDATE asset AS version SET
        "backupSourceId" = CASE WHEN version."ownerId" = NEW."ownerId" AND version."libraryId" IS NOT DISTINCT FROM NEW."libraryId" THEN NEW.id ELSE NULL END,
        "originalPath" = NEW."originalPath",
        "contentChecksum" = proposed.pin,
        "isOffline" = NEW."isOffline" OR NEW."deletedAt" IS NOT NULL OR NEW."contentChecksum" IS NULL
          OR (proposed.pin IS DISTINCT FROM NEW."contentChecksum" AND NOT EXISTS (
            SELECT 1 FROM fork_iphone_source_snapshot s WHERE s."sourceId" = NEW.id AND s.checksum = proposed.pin))
          OR version."ownerId" <> NEW."ownerId" OR version."libraryId" IS DISTINCT FROM NEW."libraryId",
        "updatedAt" = clock_timestamp()
      FROM proposed WHERE version.id = proposed.id;
      RETURN NULL;
    END
  $$;` }
];

/** 回退到已发布的引用版本，保留迁移历史中的原始函数行为。 */
const previous = [
  { name: "fork_iphone_client_checksum", sql: `CREATE OR REPLACE FUNCTION fork_iphone_client_checksum()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    DECLARE
      matching_checksum bytea;
      source_asset asset%ROWTYPE;
    BEGIN
      NEW."clientChecksum" := NULL;
      IF NEW."backupChecksum" IS NOT NULL THEN
        IF NEW."backupMetadata" IS NULL THEN
          RAISE EXCEPTION 'Invalid iPhone backup reference';
        END IF;
        IF NEW."backupSourceId" IS NULL THEN
          NEW."isOffline" := true;
          RETURN NEW;
        END IF;
        SELECT * INTO source_asset FROM asset WHERE id = NEW."backupSourceId";
        IF NOT FOUND OR source_asset.id = NEW.id OR source_asset."backupChecksum" IS NOT NULL
          OR source_asset."ownerId" <> NEW."ownerId" OR source_asset."libraryId" IS DISTINCT FROM NEW."libraryId"
          OR NEW."originalPath" <> source_asset."originalPath" THEN
          RAISE EXCEPTION 'Invalid iPhone backup reference';
        END IF;
        IF source_asset."isOffline" OR source_asset."deletedAt" IS NOT NULL
          OR source_asset."contentChecksum" IS NULL OR source_asset."contentChecksum" IS DISTINCT FROM NEW."contentChecksum" THEN
          NEW."isOffline" := true;
        END IF;
      ELSIF NEW."backupSourceId" IS NOT NULL THEN
        RAISE EXCEPTION 'Missing iPhone backup matching checksum';
      END IF;
      IF NEW."libraryId" IS NULL OR NEW."contentChecksum" IS NULL
        OR NEW."isOffline" OR NEW."deletedAt" IS NOT NULL THEN
        RETURN NEW;
      END IF;

      -- 分配发生在数据库内，覆盖上传、扫描和独立指纹任务的所有写入入口。
      PERFORM pg_advisory_xact_lock(hashtextextended('fork-iphone-client-checksum:' || NEW."libraryId"::text, 0));
      matching_checksum := coalesce(NEW."backupChecksum", NEW."contentChecksum");
      IF NOT EXISTS (
        SELECT 1 FROM asset AS other
        WHERE other."ownerId" = NEW."ownerId" AND other."libraryId" = NEW."libraryId"
          AND other.id <> NEW.id
          AND (other."clientChecksum" = matching_checksum OR other.checksum = matching_checksum)
      ) THEN
        NEW."clientChecksum" := matching_checksum;
      END IF;
      RETURN NEW;
    END
  $$;` },
  { name: "fork_iphone_reference_state", sql: `CREATE OR REPLACE FUNCTION fork_iphone_reference_state()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      UPDATE asset AS version SET
        "backupSourceId" = CASE WHEN version."ownerId" = NEW."ownerId" AND version."libraryId" IS NOT DISTINCT FROM NEW."libraryId" THEN NEW.id ELSE NULL END,
        "originalPath" = NEW."originalPath",
        "isOffline" = NEW."isOffline" OR NEW."deletedAt" IS NOT NULL OR NEW."contentChecksum" IS NULL
          OR version."contentChecksum" IS DISTINCT FROM NEW."contentChecksum"
          OR version."ownerId" <> NEW."ownerId" OR version."libraryId" IS DISTINCT FROM NEW."libraryId",
        "updatedAt" = clock_timestamp()
      WHERE version."backupSourceId" = NEW.id;
      RETURN NULL;
    END
  $$;` }
];

/** @param db 迁移事务。@param definitions 本迁移冻结的函数；以 JSON 对象保存覆盖定义，避免二次编码。 */
async function install(db: Kysely<any>, definitions: { name: string; sql: string }[]): Promise<void> {
  for (const definition of definitions) {
    await sql.raw(definition.sql).execute(db);
    const value = { type: 'function', ...definition };
    await db.insertInto('migration_overrides').values({ name: `function_${definition.name}`, value })
      .onConflict((conflict) => conflict.column('name').doUpdateSet({ value })).execute();
  }
}

/** @param db 迁移事务；仅更新引用维护函数，不重置已有手机同步或更改原片。 */
export async function up(db: Kysely<any>): Promise<void> {
  await install(db, current);
}

/** @param db 回退事务；底稿引用使用中时拒绝回退到仅依赖可变 NAS 文件的旧逻辑。 */
export async function down(db: Kysely<any>): Promise<void> {
  const result = await sql<{ present: boolean }>`SELECT EXISTS(SELECT 1 FROM fork_iphone_source_snapshot) AS present`.execute(db);
  if (result.rows[0].present) throw new Error('Restore snapshot backed versions before rollback');
  await install(db, previous);
}
