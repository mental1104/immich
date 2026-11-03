import { Kysely, sql } from 'kysely';

/**
 * 增加持久客户端匹配指纹，并沿用官方机制重置受影响用户的远端索引。
 * @param db 当前迁移事务连接；不修改原片、资产 ID 或原始两种指纹。
 * @returns 映射、索引及触发器建立完成；失败由迁移事务整体回滚。
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE asset ADD COLUMN "clientChecksum" bytea;`.execute(db);
  // 同内容只选一份在线、未删除资产，其他副本保留各自路径标识。
  await sql`WITH ranked AS (
    SELECT id, "contentChecksum", row_number() OVER (PARTITION BY "ownerId", "libraryId", "contentChecksum" ORDER BY "createdAt", id) AS rank
    FROM asset a WHERE "libraryId" IS NOT NULL AND "contentChecksum" IS NOT NULL AND NOT "isOffline" AND "deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM asset p WHERE p."ownerId" = a."ownerId" AND p."libraryId" = a."libraryId" AND p.id <> a.id AND p.checksum = a."contentChecksum")
  ) UPDATE asset a SET "clientChecksum" = CASE WHEN r.rank = 1 THEN r."contentChecksum" ELSE NULL END
    FROM ranked r WHERE a.id = r.id;`.execute(db);
  await sql`CREATE UNIQUE INDEX "fork_asset_client_checksum_idx" ON asset ("ownerId", "libraryId", "clientChecksum") WHERE "clientChecksum" IS NOT NULL;`.execute(
    db,
  );
  const indexDefinition = {
    type: 'index',
    name: 'fork_asset_client_checksum_idx',
    sql: 'CREATE UNIQUE INDEX "fork_asset_client_checksum_idx" ON "asset" ("ownerId", "libraryId", "clientChecksum") WHERE ("clientChecksum" IS NOT NULL);',
  };
  await sql`INSERT INTO migration_overrides (name, value) VALUES ('index_fork_asset_client_checksum_idx', ${sql.lit(JSON.stringify(indexDefinition))}::jsonb);`.execute(
    db,
  );
  await sql
    .raw(
      'CREATE FUNCTION fork_iphone_client_checksum() RETURNS trigger LANGUAGE plpgsql AS $function$\n    BEGIN\n      NEW."clientChecksum" := NULL;\n      IF NEW."libraryId" IS NULL OR NEW."contentChecksum" IS NULL\n        OR NEW."isOffline" OR NEW."deletedAt" IS NOT NULL THEN\n        RETURN NEW;\n      END IF;\n\n      -- 分配发生在数据库内，覆盖上传、扫描和独立指纹任务的所有写入入口。\n      PERFORM pg_advisory_xact_lock(hashtextextended(\'fork-iphone-client-checksum:\' || NEW."libraryId"::text, 0));\n      IF NOT EXISTS (\n        SELECT 1 FROM asset AS other\n        WHERE other."ownerId" = NEW."ownerId" AND other."libraryId" = NEW."libraryId"\n          AND other.id <> NEW.id\n          AND (other."clientChecksum" = NEW."contentChecksum" OR other.checksum = NEW."contentChecksum")\n      ) THEN\n        NEW."clientChecksum" := NEW."contentChecksum";\n      END IF;\n      RETURN NEW;\n    END$function$;',
    )
    .execute(db);
  await sql
    .raw(
      'CREATE FUNCTION fork_iphone_promote_checksum() RETURNS trigger LANGUAGE plpgsql AS $function$\n    DECLARE\n      candidate_id uuid;\n    BEGIN\n      IF OLD."clientChecksum" IS NULL THEN\n        RETURN NULL;\n      END IF;\n      IF TG_OP = \'UPDATE\' THEN\n        IF NEW."clientChecksum" IS NOT DISTINCT FROM OLD."clientChecksum"\n          AND NEW."ownerId" = OLD."ownerId" AND NEW."libraryId" = OLD."libraryId" THEN\n          RETURN NULL;\n        END IF;\n      END IF;\n\n      PERFORM pg_advisory_xact_lock(hashtextextended(\'fork-iphone-client-checksum:\' || OLD."libraryId"::text, 0));\n      -- 库本身已删除时不再晋升；级联删除不能重新建立匹配。\n      IF NOT EXISTS (SELECT 1 FROM library WHERE id = OLD."libraryId" AND "deletedAt" IS NULL) THEN\n        RETURN NULL;\n      END IF;\n      IF EXISTS (\n        SELECT 1 FROM asset\n        WHERE "ownerId" = OLD."ownerId" AND "libraryId" = OLD."libraryId"\n          AND ("clientChecksum" = OLD."clientChecksum" OR checksum = OLD."clientChecksum")\n      ) THEN\n        RETURN NULL;\n      END IF;\n\n      SELECT id INTO candidate_id FROM asset\n      WHERE "ownerId" = OLD."ownerId" AND "libraryId" = OLD."libraryId"\n        AND "contentChecksum" = OLD."clientChecksum" AND "clientChecksum" IS NULL\n        AND NOT "isOffline" AND "deletedAt" IS NULL\n      ORDER BY "createdAt", id LIMIT 1 FOR UPDATE;\n      IF candidate_id IS NOT NULL THEN\n        IF TG_OP = \'UPDATE\' THEN\n          -- UUID v7 只保证毫秒级时间顺序；跨过旧记录所在毫秒后再生成晋升记录，防止同毫秒随机尾部倒序。\n          PERFORM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM NEW."updatedAt" + interval \'1 millisecond\' - clock_timestamp())));\n        END IF;\n        UPDATE asset SET "clientChecksum" = "contentChecksum" WHERE id = candidate_id;\n      END IF;\n      RETURN NULL;\n    END$function$;',
    )
    .execute(db);
  await sql`CREATE TRIGGER asset_fork_iphone_checksum_insert BEFORE INSERT ON asset FOR EACH ROW EXECUTE FUNCTION fork_iphone_client_checksum();`.execute(
    db,
  );
  await sql`CREATE TRIGGER asset_fork_iphone_checksum_update BEFORE UPDATE ON asset FOR EACH ROW WHEN ((OLD."contentChecksum", OLD."clientChecksum", OLD."isOffline", OLD."deletedAt", OLD."ownerId", OLD."libraryId", OLD."checksum") IS DISTINCT FROM (NEW."contentChecksum", NEW."clientChecksum", NEW."isOffline", NEW."deletedAt", NEW."ownerId", NEW."libraryId", NEW."checksum")) EXECUTE FUNCTION fork_iphone_client_checksum();`.execute(
    db,
  );
  await sql`CREATE TRIGGER asset_fork_iphone_checksum_promote AFTER UPDATE ON asset FOR EACH ROW EXECUTE FUNCTION fork_iphone_promote_checksum();`.execute(
    db,
  );
  await sql`CREATE TRIGGER asset_fork_iphone_checksum_delete AFTER DELETE ON asset FOR EACH ROW EXECUTE FUNCTION fork_iphone_promote_checksum();`.execute(
    db,
  );
  // 持久记录 sql-tools 的规范描述，避免 PostgreSQL 反解析格式造成伪结构漂移。
  await sql
    .raw(
      'INSERT INTO migration_overrides (name, value) VALUES (\'function_fork_iphone_client_checksum\', \'{"type":"function","name":"fork_iphone_client_checksum","sql":"CREATE OR REPLACE FUNCTION fork_iphone_client_checksum()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      NEW.\\"clientChecksum\\" := NULL;\\n      IF NEW.\\"libraryId\\" IS NULL OR NEW.\\"contentChecksum\\" IS NULL\\n        OR NEW.\\"isOffline\\" OR NEW.\\"deletedAt\\" IS NOT NULL THEN\\n        RETURN NEW;\\n      END IF;\\n\\n      -- 分配发生在数据库内，覆盖上传、扫描和独立指纹任务的所有写入入口。\\n      PERFORM pg_advisory_xact_lock(hashtextextended(\'\'fork-iphone-client-checksum:\'\' || NEW.\\"libraryId\\"::text, 0));\\n      IF NOT EXISTS (\\n        SELECT 1 FROM asset AS other\\n        WHERE other.\\"ownerId\\" = NEW.\\"ownerId\\" AND other.\\"libraryId\\" = NEW.\\"libraryId\\"\\n          AND other.id <> NEW.id\\n          AND (other.\\"clientChecksum\\" = NEW.\\"contentChecksum\\" OR other.checksum = NEW.\\"contentChecksum\\")\\n      ) THEN\\n        NEW.\\"clientChecksum\\" := NEW.\\"contentChecksum\\";\\n      END IF;\\n      RETURN NEW;\\n    END\\n  $$;"}\'::jsonb), (\'function_fork_iphone_promote_checksum\', \'{"type":"function","name":"fork_iphone_promote_checksum","sql":"CREATE OR REPLACE FUNCTION fork_iphone_promote_checksum()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    DECLARE\\n      candidate_id uuid;\\n    BEGIN\\n      IF OLD.\\"clientChecksum\\" IS NULL THEN\\n        RETURN NULL;\\n      END IF;\\n      IF TG_OP = \'\'UPDATE\'\' THEN\\n        IF NEW.\\"clientChecksum\\" IS NOT DISTINCT FROM OLD.\\"clientChecksum\\"\\n          AND NEW.\\"ownerId\\" = OLD.\\"ownerId\\" AND NEW.\\"libraryId\\" = OLD.\\"libraryId\\" THEN\\n          RETURN NULL;\\n        END IF;\\n      END IF;\\n\\n      PERFORM pg_advisory_xact_lock(hashtextextended(\'\'fork-iphone-client-checksum:\'\' || OLD.\\"libraryId\\"::text, 0));\\n      -- 库本身已删除时不再晋升；级联删除不能重新建立匹配。\\n      IF NOT EXISTS (SELECT 1 FROM library WHERE id = OLD.\\"libraryId\\" AND \\"deletedAt\\" IS NULL) THEN\\n        RETURN NULL;\\n      END IF;\\n      IF EXISTS (\\n        SELECT 1 FROM asset\\n        WHERE \\"ownerId\\" = OLD.\\"ownerId\\" AND \\"libraryId\\" = OLD.\\"libraryId\\"\\n          AND (\\"clientChecksum\\" = OLD.\\"clientChecksum\\" OR checksum = OLD.\\"clientChecksum\\")\\n      ) THEN\\n        RETURN NULL;\\n      END IF;\\n\\n      SELECT id INTO candidate_id FROM asset\\n      WHERE \\"ownerId\\" = OLD.\\"ownerId\\" AND \\"libraryId\\" = OLD.\\"libraryId\\"\\n        AND \\"contentChecksum\\" = OLD.\\"clientChecksum\\" AND \\"clientChecksum\\" IS NULL\\n        AND NOT \\"isOffline\\" AND \\"deletedAt\\" IS NULL\\n      ORDER BY \\"createdAt\\", id LIMIT 1 FOR UPDATE;\\n      IF candidate_id IS NOT NULL THEN\\n        IF TG_OP = \'\'UPDATE\'\' THEN\\n          -- UUID v7 只保证毫秒级时间顺序；跨过旧记录所在毫秒后再生成晋升记录，防止同毫秒随机尾部倒序。\\n          PERFORM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM NEW.\\"updatedAt\\" + interval \'\'1 millisecond\'\' - clock_timestamp())));\\n        END IF;\\n        UPDATE asset SET \\"clientChecksum\\" = \\"contentChecksum\\" WHERE id = candidate_id;\\n      END IF;\\n      RETURN NULL;\\n    END\\n  $$;"}\'::jsonb), (\'trigger_asset_fork_iphone_checksum_insert\', \'{"type":"trigger","name":"asset_fork_iphone_checksum_insert","sql":"CREATE OR REPLACE TRIGGER \\"asset_fork_iphone_checksum_insert\\"\\n  BEFORE INSERT ON \\"asset\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION fork_iphone_client_checksum();"}\'::jsonb), (\'trigger_asset_fork_iphone_checksum_update\', \'{"type":"trigger","name":"asset_fork_iphone_checksum_update","sql":"CREATE OR REPLACE TRIGGER \\"asset_fork_iphone_checksum_update\\"\\n  BEFORE UPDATE ON \\"asset\\"\\n  FOR EACH ROW\\n  WHEN ((OLD.\\"contentChecksum\\", OLD.\\"clientChecksum\\", OLD.\\"isOffline\\", OLD.\\"deletedAt\\", OLD.\\"ownerId\\", OLD.\\"libraryId\\", OLD.\\"checksum\\") IS DISTINCT FROM (NEW.\\"contentChecksum\\", NEW.\\"clientChecksum\\", NEW.\\"isOffline\\", NEW.\\"deletedAt\\", NEW.\\"ownerId\\", NEW.\\"libraryId\\", NEW.\\"checksum\\"))\\n  EXECUTE FUNCTION fork_iphone_client_checksum();"}\'::jsonb), (\'trigger_asset_fork_iphone_checksum_promote\', \'{"type":"trigger","name":"asset_fork_iphone_checksum_promote","sql":"CREATE OR REPLACE TRIGGER \\"asset_fork_iphone_checksum_promote\\"\\n  AFTER UPDATE ON \\"asset\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION fork_iphone_promote_checksum();"}\'::jsonb), (\'trigger_asset_fork_iphone_checksum_delete\', \'{"type":"trigger","name":"asset_fork_iphone_checksum_delete","sql":"CREATE OR REPLACE TRIGGER \\"asset_fork_iphone_checksum_delete\\"\\n  AFTER DELETE ON \\"asset\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION fork_iphone_promote_checksum();"}\'::jsonb);',
    )
    .execute(db);
  // 旧手机索引可能已持有错误的重复映射；必须从空的远端索引接收一致快照。
  await sql`UPDATE session SET "isPendingSyncReset" = true WHERE "userId" IN (SELECT DISTINCT "ownerId" FROM asset WHERE "libraryId" IS NOT NULL AND "contentChecksum" IS NOT NULL);`.execute(
    db,
  );
}

/** @param db 当前回退事务连接。 @returns 删除本次结构，原始指纹和原片保留；会话重置标记不撤销。 */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER asset_fork_iphone_checksum_delete ON asset;`.execute(db);
  await sql`DROP TRIGGER asset_fork_iphone_checksum_promote ON asset;`.execute(db);
  await sql`DROP TRIGGER asset_fork_iphone_checksum_update ON asset;`.execute(db);
  await sql`DROP TRIGGER asset_fork_iphone_checksum_insert ON asset;`.execute(db);
  await sql`DROP FUNCTION fork_iphone_promote_checksum();`.execute(db);
  await sql`DROP FUNCTION fork_iphone_client_checksum();`.execute(db);
  await sql
    .raw(
      "DELETE FROM migration_overrides WHERE name IN ('function_fork_iphone_client_checksum', 'function_fork_iphone_promote_checksum', 'trigger_asset_fork_iphone_checksum_insert', 'trigger_asset_fork_iphone_checksum_update', 'trigger_asset_fork_iphone_checksum_promote', 'trigger_asset_fork_iphone_checksum_delete');",
    )
    .execute(db);
  await sql`DROP INDEX fork_asset_client_checksum_idx;`.execute(db);
  await sql`DELETE FROM migration_overrides WHERE name = 'index_fork_asset_client_checksum_idx';`.execute(db);
  await sql`ALTER TABLE asset DROP COLUMN "clientChecksum";`.execute(db);
}
