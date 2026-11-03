import { registerFunction } from '@immich/sql-tools';

/**
 * 为同用户、同外部库的一组内容副本保留一个持久客户端指纹代表。
 * NEW 是待写资产；库级事务锁串行分配，其他副本保留路径标识，原始内容指纹不变。
 * 返回校正后的 NEW；唯一索引作为最后防线，SQL 失败时整笔写入回滚。
 */
export const fork_iphone_client_checksum = registerFunction({
  name: 'fork_iphone_client_checksum',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
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
    END`,
});

/**
 * 代表被删除、离线或改变内容后，将原内容的匹配资格交给一个仍在线的副本。
 * OLD 是已完成变更的资产；先更新旧代表再晋升新代表，沿用 updateId 生成可恢复的增量同步顺序。
 * 返回 NULL；只改数据库映射，不读写原片，异常由当前事务回滚。
 */
export const fork_iphone_promote_checksum = registerFunction({
  name: 'fork_iphone_promote_checksum',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
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
    END`,
});
