import { Kysely, sql } from 'kysely';

/**
 * 增加元数据版本的持久关联及无损恢复配方，不回扫、不改原片，不重置既有会话。
 * @param db 当前迁移事务。
 * @returns 结构和保护触发器创建完成；任何失败都由迁移器回滚。
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw('ALTER TABLE asset ADD COLUMN "backupMetadata" bytea, ADD COLUMN "backupOriginalPath" character varying, ADD COLUMN "backupChecksum" bytea, ADD COLUMN "backupSourceId" uuid REFERENCES asset(id) ON UPDATE CASCADE ON DELETE SET NULL;').execute(db);
  await sql.raw('CREATE INDEX "asset_backupSourceId_idx" ON asset ("backupSourceId");').execute(db);
  await sql.raw(`CREATE OR REPLACE FUNCTION fork_iphone_client_checksum()
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
  $$;`).execute(db);
  await sql.raw(`CREATE OR REPLACE FUNCTION fork_iphone_promote_checksum()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    DECLARE
      candidate_id uuid;
    BEGIN
      IF OLD."clientChecksum" IS NULL THEN
        RETURN NULL;
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF NEW."clientChecksum" IS NOT DISTINCT FROM OLD."clientChecksum"
          AND NEW."ownerId" = OLD."ownerId" AND NEW."libraryId" = OLD."libraryId" THEN
          RETURN NULL;
        END IF;
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended('fork-iphone-client-checksum:' || OLD."libraryId"::text, 0));
      -- 库本身已删除时不再晋升；级联删除不能重新建立匹配。
      IF NOT EXISTS (SELECT 1 FROM library WHERE id = OLD."libraryId" AND "deletedAt" IS NULL) THEN
        RETURN NULL;
      END IF;
      IF EXISTS (
        SELECT 1 FROM asset
        WHERE "ownerId" = OLD."ownerId" AND "libraryId" = OLD."libraryId"
          AND ("clientChecksum" = OLD."clientChecksum" OR checksum = OLD."clientChecksum")
      ) THEN
        RETURN NULL;
      END IF;

      SELECT id INTO candidate_id FROM asset
      WHERE "ownerId" = OLD."ownerId" AND "libraryId" = OLD."libraryId"
        AND coalesce("backupChecksum", "contentChecksum") = OLD."clientChecksum" AND "clientChecksum" IS NULL
        AND NOT "isOffline" AND "deletedAt" IS NULL
      ORDER BY "createdAt", id LIMIT 1 FOR UPDATE;
      IF candidate_id IS NOT NULL THEN
        IF TG_OP = 'UPDATE' THEN
          -- UUID v7 只保证毫秒级时间顺序；跨过旧记录所在毫秒后再生成晋升记录，防止同毫秒随机尾部倒序。
          PERFORM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM NEW."updatedAt" + interval '1 millisecond' - clock_timestamp())));
        END IF;
        UPDATE asset SET "clientChecksum" = coalesce("backupChecksum", "contentChecksum") WHERE id = candidate_id;
      END IF;
      RETURN NULL;
    END
  $$;`).execute(db);
  await sql.raw(`CREATE OR REPLACE FUNCTION fork_iphone_reference_state()
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
  $$;`).execute(db);
  await sql.raw(`CREATE OR REPLACE TRIGGER "asset_fork_iphone_checksum_delete"
  AFTER DELETE ON "asset"
  FOR EACH ROW
  EXECUTE FUNCTION fork_iphone_promote_checksum();`).execute(db);
  await sql.raw(`CREATE OR REPLACE TRIGGER "asset_fork_iphone_checksum_promote"
  AFTER UPDATE ON "asset"
  FOR EACH ROW
  EXECUTE FUNCTION fork_iphone_promote_checksum();`).execute(db);
  await sql.raw(`CREATE OR REPLACE TRIGGER "asset_fork_iphone_reference_state"
  AFTER UPDATE ON "asset"
  FOR EACH ROW
  WHEN ((OLD."contentChecksum", OLD."originalPath", OLD."isOffline", OLD."deletedAt", OLD."ownerId", OLD."libraryId") IS DISTINCT FROM (NEW."contentChecksum", NEW."originalPath", NEW."isOffline", NEW."deletedAt", NEW."ownerId", NEW."libraryId"))
  EXECUTE FUNCTION fork_iphone_reference_state();`).execute(db);
  await sql.raw(`CREATE OR REPLACE TRIGGER "asset_fork_iphone_checksum_update"
  BEFORE UPDATE ON "asset"
  FOR EACH ROW
  WHEN ((OLD."contentChecksum", OLD."clientChecksum", OLD."backupChecksum", OLD."backupSourceId", OLD."isOffline", OLD."deletedAt", OLD."ownerId", OLD."libraryId", OLD."checksum") IS DISTINCT FROM (NEW."contentChecksum", NEW."clientChecksum", NEW."backupChecksum", NEW."backupSourceId", NEW."isOffline", NEW."deletedAt", NEW."ownerId", NEW."libraryId", NEW."checksum"))
  EXECUTE FUNCTION fork_iphone_client_checksum();`).execute(db);
  await sql.raw(`CREATE OR REPLACE TRIGGER "asset_fork_iphone_checksum_insert"
  BEFORE INSERT ON "asset"
  FOR EACH ROW
  EXECUTE FUNCTION fork_iphone_client_checksum();`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('function_fork_iphone_client_checksum','{"type":"function","name":"fork_iphone_client_checksum","sql":"CREATE OR REPLACE FUNCTION fork_iphone_client_checksum()\n  RETURNS TRIGGER\n  LANGUAGE PLPGSQL\n  AS $$\n    DECLARE\n      matching_checksum bytea;\n      source_asset asset%ROWTYPE;\n    BEGIN\n      NEW.\"clientChecksum\" := NULL;\n      IF NEW.\"backupChecksum\" IS NOT NULL THEN\n        IF NEW.\"backupMetadata\" IS NULL THEN\n          RAISE EXCEPTION ''Invalid iPhone backup reference'';\n        END IF;\n        IF NEW.\"backupSourceId\" IS NULL THEN\n          NEW.\"isOffline\" := true;\n          RETURN NEW;\n        END IF;\n        SELECT * INTO source_asset FROM asset WHERE id = NEW.\"backupSourceId\";\n        IF NOT FOUND OR source_asset.id = NEW.id OR source_asset.\"backupChecksum\" IS NOT NULL\n          OR source_asset.\"ownerId\" <> NEW.\"ownerId\" OR source_asset.\"libraryId\" IS DISTINCT FROM NEW.\"libraryId\"\n          OR NEW.\"originalPath\" <> source_asset.\"originalPath\" THEN\n          RAISE EXCEPTION ''Invalid iPhone backup reference'';\n        END IF;\n        IF source_asset.\"isOffline\" OR source_asset.\"deletedAt\" IS NOT NULL\n          OR source_asset.\"contentChecksum\" IS NULL OR source_asset.\"contentChecksum\" IS DISTINCT FROM NEW.\"contentChecksum\" THEN\n          NEW.\"isOffline\" := true;\n        END IF;\n      ELSIF NEW.\"backupSourceId\" IS NOT NULL THEN\n        RAISE EXCEPTION ''Missing iPhone backup matching checksum'';\n      END IF;\n      IF NEW.\"libraryId\" IS NULL OR NEW.\"contentChecksum\" IS NULL\n        OR NEW.\"isOffline\" OR NEW.\"deletedAt\" IS NOT NULL THEN\n        RETURN NEW;\n      END IF;\n\n      -- 分配发生在数据库内，覆盖上传、扫描和独立指纹任务的所有写入入口。\n      PERFORM pg_advisory_xact_lock(hashtextextended(''fork-iphone-client-checksum:'' || NEW.\"libraryId\"::text, 0));\n      matching_checksum := coalesce(NEW.\"backupChecksum\", NEW.\"contentChecksum\");\n      IF NOT EXISTS (\n        SELECT 1 FROM asset AS other\n        WHERE other.\"ownerId\" = NEW.\"ownerId\" AND other.\"libraryId\" = NEW.\"libraryId\"\n          AND other.id <> NEW.id\n          AND (other.\"clientChecksum\" = matching_checksum OR other.checksum = matching_checksum)\n      ) THEN\n        NEW.\"clientChecksum\" := matching_checksum;\n      END IF;\n      RETURN NEW;\n    END\n  $$;"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('function_fork_iphone_promote_checksum','{"type":"function","name":"fork_iphone_promote_checksum","sql":"CREATE OR REPLACE FUNCTION fork_iphone_promote_checksum()\n  RETURNS TRIGGER\n  LANGUAGE PLPGSQL\n  AS $$\n    DECLARE\n      candidate_id uuid;\n    BEGIN\n      IF OLD.\"clientChecksum\" IS NULL THEN\n        RETURN NULL;\n      END IF;\n      IF TG_OP = ''UPDATE'' THEN\n        IF NEW.\"clientChecksum\" IS NOT DISTINCT FROM OLD.\"clientChecksum\"\n          AND NEW.\"ownerId\" = OLD.\"ownerId\" AND NEW.\"libraryId\" = OLD.\"libraryId\" THEN\n          RETURN NULL;\n        END IF;\n      END IF;\n\n      PERFORM pg_advisory_xact_lock(hashtextextended(''fork-iphone-client-checksum:'' || OLD.\"libraryId\"::text, 0));\n      -- 库本身已删除时不再晋升；级联删除不能重新建立匹配。\n      IF NOT EXISTS (SELECT 1 FROM library WHERE id = OLD.\"libraryId\" AND \"deletedAt\" IS NULL) THEN\n        RETURN NULL;\n      END IF;\n      IF EXISTS (\n        SELECT 1 FROM asset\n        WHERE \"ownerId\" = OLD.\"ownerId\" AND \"libraryId\" = OLD.\"libraryId\"\n          AND (\"clientChecksum\" = OLD.\"clientChecksum\" OR checksum = OLD.\"clientChecksum\")\n      ) THEN\n        RETURN NULL;\n      END IF;\n\n      SELECT id INTO candidate_id FROM asset\n      WHERE \"ownerId\" = OLD.\"ownerId\" AND \"libraryId\" = OLD.\"libraryId\"\n        AND coalesce(\"backupChecksum\", \"contentChecksum\") = OLD.\"clientChecksum\" AND \"clientChecksum\" IS NULL\n        AND NOT \"isOffline\" AND \"deletedAt\" IS NULL\n      ORDER BY \"createdAt\", id LIMIT 1 FOR UPDATE;\n      IF candidate_id IS NOT NULL THEN\n        IF TG_OP = ''UPDATE'' THEN\n          -- UUID v7 只保证毫秒级时间顺序；跨过旧记录所在毫秒后再生成晋升记录，防止同毫秒随机尾部倒序。\n          PERFORM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM NEW.\"updatedAt\" + interval ''1 millisecond'' - clock_timestamp())));\n        END IF;\n        UPDATE asset SET \"clientChecksum\" = coalesce(\"backupChecksum\", \"contentChecksum\") WHERE id = candidate_id;\n      END IF;\n      RETURN NULL;\n    END\n  $$;"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('function_fork_iphone_reference_state','{"type":"function","name":"fork_iphone_reference_state","sql":"CREATE OR REPLACE FUNCTION fork_iphone_reference_state()\n  RETURNS TRIGGER\n  LANGUAGE PLPGSQL\n  AS $$\n    BEGIN\n      UPDATE asset AS version SET\n        \"backupSourceId\" = CASE WHEN version.\"ownerId\" = NEW.\"ownerId\" AND version.\"libraryId\" IS NOT DISTINCT FROM NEW.\"libraryId\" THEN NEW.id ELSE NULL END,\n        \"originalPath\" = NEW.\"originalPath\",\n        \"isOffline\" = NEW.\"isOffline\" OR NEW.\"deletedAt\" IS NOT NULL OR NEW.\"contentChecksum\" IS NULL\n          OR version.\"contentChecksum\" IS DISTINCT FROM NEW.\"contentChecksum\"\n          OR version.\"ownerId\" <> NEW.\"ownerId\" OR version.\"libraryId\" IS DISTINCT FROM NEW.\"libraryId\",\n        \"updatedAt\" = clock_timestamp()\n      WHERE version.\"backupSourceId\" = NEW.id;\n      RETURN NULL;\n    END\n  $$;"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('trigger_asset_fork_iphone_checksum_delete','{"type":"trigger","name":"asset_fork_iphone_checksum_delete","sql":"CREATE OR REPLACE TRIGGER \"asset_fork_iphone_checksum_delete\"\n  AFTER DELETE ON \"asset\"\n  FOR EACH ROW\n  EXECUTE FUNCTION fork_iphone_promote_checksum();"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('trigger_asset_fork_iphone_checksum_promote','{"type":"trigger","name":"asset_fork_iphone_checksum_promote","sql":"CREATE OR REPLACE TRIGGER \"asset_fork_iphone_checksum_promote\"\n  AFTER UPDATE ON \"asset\"\n  FOR EACH ROW\n  EXECUTE FUNCTION fork_iphone_promote_checksum();"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('trigger_asset_fork_iphone_reference_state','{"type":"trigger","name":"asset_fork_iphone_reference_state","sql":"CREATE OR REPLACE TRIGGER \"asset_fork_iphone_reference_state\"\n  AFTER UPDATE ON \"asset\"\n  FOR EACH ROW\n  WHEN ((OLD.\"contentChecksum\", OLD.\"originalPath\", OLD.\"isOffline\", OLD.\"deletedAt\", OLD.\"ownerId\", OLD.\"libraryId\") IS DISTINCT FROM (NEW.\"contentChecksum\", NEW.\"originalPath\", NEW.\"isOffline\", NEW.\"deletedAt\", NEW.\"ownerId\", NEW.\"libraryId\"))\n  EXECUTE FUNCTION fork_iphone_reference_state();"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('trigger_asset_fork_iphone_checksum_update','{"type":"trigger","name":"asset_fork_iphone_checksum_update","sql":"CREATE OR REPLACE TRIGGER \"asset_fork_iphone_checksum_update\"\n  BEFORE UPDATE ON \"asset\"\n  FOR EACH ROW\n  WHEN ((OLD.\"contentChecksum\", OLD.\"clientChecksum\", OLD.\"backupChecksum\", OLD.\"backupSourceId\", OLD.\"isOffline\", OLD.\"deletedAt\", OLD.\"ownerId\", OLD.\"libraryId\", OLD.\"checksum\") IS DISTINCT FROM (NEW.\"contentChecksum\", NEW.\"clientChecksum\", NEW.\"backupChecksum\", NEW.\"backupSourceId\", NEW.\"isOffline\", NEW.\"deletedAt\", NEW.\"ownerId\", NEW.\"libraryId\", NEW.\"checksum\"))\n  EXECUTE FUNCTION fork_iphone_client_checksum();"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('trigger_asset_fork_iphone_checksum_insert','{"type":"trigger","name":"asset_fork_iphone_checksum_insert","sql":"CREATE OR REPLACE TRIGGER \"asset_fork_iphone_checksum_insert\"\n  BEFORE INSERT ON \"asset\"\n  FOR EACH ROW\n  EXECUTE FUNCTION fork_iphone_client_checksum();"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
}

/**
 * 只有全部版本已无损恢复为独立文件时才允许回退；拒绝破坏已经清理的匹配记录。
 * @param db 当前迁移事务。
 * @returns 原有结构与 schema 覆盖恢复；存在引用版本时直接拒绝。
 */
export async function down(db: Kysely<any>): Promise<void> {
  await sql.raw('DO $$ BEGIN IF EXISTS (SELECT 1 FROM asset WHERE "backupChecksum" IS NOT NULL) THEN RAISE EXCEPTION \'Restore referenced backup files before rollback\'; END IF; END $$;').execute(db);
  await sql.raw('DROP TRIGGER asset_fork_iphone_reference_state ON asset; DROP FUNCTION fork_iphone_reference_state();').execute(db);
  await sql.raw(`CREATE OR REPLACE FUNCTION fork_iphone_client_checksum()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      NEW."clientChecksum" := NULL;
      IF NEW."libraryId" IS NULL OR NEW."contentChecksum" IS NULL
        OR NEW."isOffline" OR NEW."deletedAt" IS NOT NULL THEN
        RETURN NEW;
      END IF;

      -- 分配发生在数据库内，覆盖上传、扫描和独立指纹任务的所有写入入口。
      PERFORM pg_advisory_xact_lock(hashtextextended('fork-iphone-client-checksum:' || NEW."libraryId"::text, 0));
      IF NOT EXISTS (
        SELECT 1 FROM asset AS other
        WHERE other."ownerId" = NEW."ownerId" AND other."libraryId" = NEW."libraryId"
          AND other.id <> NEW.id
          AND (other."clientChecksum" = NEW."contentChecksum" OR other.checksum = NEW."contentChecksum")
      ) THEN
        NEW."clientChecksum" := NEW."contentChecksum";
      END IF;
      RETURN NEW;
    END
  $$;`).execute(db);
  await sql.raw(`CREATE OR REPLACE FUNCTION fork_iphone_promote_checksum()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    DECLARE
      candidate_id uuid;
    BEGIN
      IF OLD."clientChecksum" IS NULL THEN
        RETURN NULL;
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF NEW."clientChecksum" IS NOT DISTINCT FROM OLD."clientChecksum"
          AND NEW."ownerId" = OLD."ownerId" AND NEW."libraryId" = OLD."libraryId" THEN
          RETURN NULL;
        END IF;
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended('fork-iphone-client-checksum:' || OLD."libraryId"::text, 0));
      -- 库本身已删除时不再晋升；级联删除不能重新建立匹配。
      IF NOT EXISTS (SELECT 1 FROM library WHERE id = OLD."libraryId" AND "deletedAt" IS NULL) THEN
        RETURN NULL;
      END IF;
      IF EXISTS (
        SELECT 1 FROM asset
        WHERE "ownerId" = OLD."ownerId" AND "libraryId" = OLD."libraryId"
          AND ("clientChecksum" = OLD."clientChecksum" OR checksum = OLD."clientChecksum")
      ) THEN
        RETURN NULL;
      END IF;

      SELECT id INTO candidate_id FROM asset
      WHERE "ownerId" = OLD."ownerId" AND "libraryId" = OLD."libraryId"
        AND "contentChecksum" = OLD."clientChecksum" AND "clientChecksum" IS NULL
        AND NOT "isOffline" AND "deletedAt" IS NULL
      ORDER BY "createdAt", id LIMIT 1 FOR UPDATE;
      IF candidate_id IS NOT NULL THEN
        IF TG_OP = 'UPDATE' THEN
          -- UUID v7 只保证毫秒级时间顺序；跨过旧记录所在毫秒后再生成晋升记录，防止同毫秒随机尾部倒序。
          PERFORM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM NEW."updatedAt" + interval '1 millisecond' - clock_timestamp())));
        END IF;
        UPDATE asset SET "clientChecksum" = "contentChecksum" WHERE id = candidate_id;
      END IF;
      RETURN NULL;
    END
  $$;`).execute(db);
  await sql.raw(`CREATE OR REPLACE TRIGGER "asset_fork_iphone_checksum_insert"
  BEFORE INSERT ON "asset"
  FOR EACH ROW
  EXECUTE FUNCTION fork_iphone_client_checksum();`).execute(db);
  await sql.raw(`CREATE OR REPLACE TRIGGER "asset_fork_iphone_checksum_update"
  BEFORE UPDATE ON "asset"
  FOR EACH ROW
  WHEN ((OLD."contentChecksum", OLD."clientChecksum", OLD."isOffline", OLD."deletedAt", OLD."ownerId", OLD."libraryId", OLD."checksum") IS DISTINCT FROM (NEW."contentChecksum", NEW."clientChecksum", NEW."isOffline", NEW."deletedAt", NEW."ownerId", NEW."libraryId", NEW."checksum"))
  EXECUTE FUNCTION fork_iphone_client_checksum();`).execute(db);
  await sql.raw(`CREATE OR REPLACE TRIGGER "asset_fork_iphone_checksum_promote"
  AFTER UPDATE ON "asset"
  FOR EACH ROW
  EXECUTE FUNCTION fork_iphone_promote_checksum();`).execute(db);
  await sql.raw(`CREATE OR REPLACE TRIGGER "asset_fork_iphone_checksum_delete"
  AFTER DELETE ON "asset"
  FOR EACH ROW
  EXECUTE FUNCTION fork_iphone_promote_checksum();`).execute(db);
  await sql.raw('DELETE FROM migration_overrides WHERE name IN (\'function_fork_iphone_reference_state\',\'trigger_asset_fork_iphone_reference_state\');').execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('function_fork_iphone_client_checksum','{"type":"function","name":"fork_iphone_client_checksum","sql":"CREATE OR REPLACE FUNCTION fork_iphone_client_checksum()\n  RETURNS TRIGGER\n  LANGUAGE PLPGSQL\n  AS $$\n    BEGIN\n      NEW.\"clientChecksum\" := NULL;\n      IF NEW.\"libraryId\" IS NULL OR NEW.\"contentChecksum\" IS NULL\n        OR NEW.\"isOffline\" OR NEW.\"deletedAt\" IS NOT NULL THEN\n        RETURN NEW;\n      END IF;\n\n      -- 分配发生在数据库内，覆盖上传、扫描和独立指纹任务的所有写入入口。\n      PERFORM pg_advisory_xact_lock(hashtextextended(''fork-iphone-client-checksum:'' || NEW.\"libraryId\"::text, 0));\n      IF NOT EXISTS (\n        SELECT 1 FROM asset AS other\n        WHERE other.\"ownerId\" = NEW.\"ownerId\" AND other.\"libraryId\" = NEW.\"libraryId\"\n          AND other.id <> NEW.id\n          AND (other.\"clientChecksum\" = NEW.\"contentChecksum\" OR other.checksum = NEW.\"contentChecksum\")\n      ) THEN\n        NEW.\"clientChecksum\" := NEW.\"contentChecksum\";\n      END IF;\n      RETURN NEW;\n    END\n  $$;"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('function_fork_iphone_promote_checksum','{"type":"function","name":"fork_iphone_promote_checksum","sql":"CREATE OR REPLACE FUNCTION fork_iphone_promote_checksum()\n  RETURNS TRIGGER\n  LANGUAGE PLPGSQL\n  AS $$\n    DECLARE\n      candidate_id uuid;\n    BEGIN\n      IF OLD.\"clientChecksum\" IS NULL THEN\n        RETURN NULL;\n      END IF;\n      IF TG_OP = ''UPDATE'' THEN\n        IF NEW.\"clientChecksum\" IS NOT DISTINCT FROM OLD.\"clientChecksum\"\n          AND NEW.\"ownerId\" = OLD.\"ownerId\" AND NEW.\"libraryId\" = OLD.\"libraryId\" THEN\n          RETURN NULL;\n        END IF;\n      END IF;\n\n      PERFORM pg_advisory_xact_lock(hashtextextended(''fork-iphone-client-checksum:'' || OLD.\"libraryId\"::text, 0));\n      -- 库本身已删除时不再晋升；级联删除不能重新建立匹配。\n      IF NOT EXISTS (SELECT 1 FROM library WHERE id = OLD.\"libraryId\" AND \"deletedAt\" IS NULL) THEN\n        RETURN NULL;\n      END IF;\n      IF EXISTS (\n        SELECT 1 FROM asset\n        WHERE \"ownerId\" = OLD.\"ownerId\" AND \"libraryId\" = OLD.\"libraryId\"\n          AND (\"clientChecksum\" = OLD.\"clientChecksum\" OR checksum = OLD.\"clientChecksum\")\n      ) THEN\n        RETURN NULL;\n      END IF;\n\n      SELECT id INTO candidate_id FROM asset\n      WHERE \"ownerId\" = OLD.\"ownerId\" AND \"libraryId\" = OLD.\"libraryId\"\n        AND \"contentChecksum\" = OLD.\"clientChecksum\" AND \"clientChecksum\" IS NULL\n        AND NOT \"isOffline\" AND \"deletedAt\" IS NULL\n      ORDER BY \"createdAt\", id LIMIT 1 FOR UPDATE;\n      IF candidate_id IS NOT NULL THEN\n        IF TG_OP = ''UPDATE'' THEN\n          -- UUID v7 只保证毫秒级时间顺序；跨过旧记录所在毫秒后再生成晋升记录，防止同毫秒随机尾部倒序。\n          PERFORM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM NEW.\"updatedAt\" + interval ''1 millisecond'' - clock_timestamp())));\n        END IF;\n        UPDATE asset SET \"clientChecksum\" = \"contentChecksum\" WHERE id = candidate_id;\n      END IF;\n      RETURN NULL;\n    END\n  $$;"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('trigger_asset_fork_iphone_checksum_insert','{"type":"trigger","name":"asset_fork_iphone_checksum_insert","sql":"CREATE OR REPLACE TRIGGER \"asset_fork_iphone_checksum_insert\"\n  BEFORE INSERT ON \"asset\"\n  FOR EACH ROW\n  EXECUTE FUNCTION fork_iphone_client_checksum();"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('trigger_asset_fork_iphone_checksum_update','{"type":"trigger","name":"asset_fork_iphone_checksum_update","sql":"CREATE OR REPLACE TRIGGER \"asset_fork_iphone_checksum_update\"\n  BEFORE UPDATE ON \"asset\"\n  FOR EACH ROW\n  WHEN ((OLD.\"contentChecksum\", OLD.\"clientChecksum\", OLD.\"isOffline\", OLD.\"deletedAt\", OLD.\"ownerId\", OLD.\"libraryId\", OLD.\"checksum\") IS DISTINCT FROM (NEW.\"contentChecksum\", NEW.\"clientChecksum\", NEW.\"isOffline\", NEW.\"deletedAt\", NEW.\"ownerId\", NEW.\"libraryId\", NEW.\"checksum\"))\n  EXECUTE FUNCTION fork_iphone_client_checksum();"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('trigger_asset_fork_iphone_checksum_promote','{"type":"trigger","name":"asset_fork_iphone_checksum_promote","sql":"CREATE OR REPLACE TRIGGER \"asset_fork_iphone_checksum_promote\"\n  AFTER UPDATE ON \"asset\"\n  FOR EACH ROW\n  EXECUTE FUNCTION fork_iphone_promote_checksum();"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw(String.raw`INSERT INTO migration_overrides (name,value) VALUES ('trigger_asset_fork_iphone_checksum_delete','{"type":"trigger","name":"asset_fork_iphone_checksum_delete","sql":"CREATE OR REPLACE TRIGGER \"asset_fork_iphone_checksum_delete\"\n  AFTER DELETE ON \"asset\"\n  FOR EACH ROW\n  EXECUTE FUNCTION fork_iphone_promote_checksum();"}'::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;`).execute(db);
  await sql.raw('ALTER TABLE asset DROP COLUMN "backupSourceId", DROP COLUMN "backupChecksum", DROP COLUMN "backupOriginalPath", DROP COLUMN "backupMetadata";').execute(db);
}
