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
    END`,
});

/**
 * 物理原片变化时传播状态；已受保护的旧编码仍由不可变底稿提供，不能因 NAS 重编码而丢失备份。
 * NEW 是已经更新的物理资产；仅传播给直接引用，禁止引用链，返回 NULL 不改变原片。
 */
export const fork_iphone_reference_state = registerFunction({
  name: 'fork_iphone_reference_state',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
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
    END`,
});
