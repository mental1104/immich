import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { sql } from 'kysely';

/** Fork 的外部图库指纹缓存键；原始资产 checksum 保留路径 SHA1。 */
export const EXTERNAL_CONTENT_HASH_KEY = 'fork:external-content-sha1-v1';

/** 是否允许图库扫描任务读取原片内容并计算 SHA1；默认禁用。 */
export const isExternalContentHashIndexEnabled = () => process.env.IMMICH_EXTERNAL_CONTENT_HASH_INDEX === 'true';

/** 是否允许对客户端同步经过验证的内容 SHA1；默认禁用。 */
export const isExternalContentHashSyncEnabled = () => process.env.IMMICH_EXTERNAL_CONTENT_HASH_SYNC === 'true';

/**
 * 判断已保存的内容哈希是否仍适用于当前文件。
 * @param value 元数据 JSON，含 sha1、size、mtimeMs、published。
 * @param stat 当前原片文件状态。
 * @returns 指纹有效且文件大小、修改时间未变化时返回 true。
 */
export const isReusableExternalContentHash = (value: Record<string, unknown> | undefined, stat: Stats): boolean =>
  typeof value?.sha1 === 'string' &&
  /^[a-f0-9]{40}$/.test(value.sha1) &&
  value.size === stat.size &&
  value.mtimeMs === stat.mtimeMs;

/**
 * 顺序流式计算原片内容 SHA1，不会修改文件或将其整体加载到内存。
 * @param filename 服务端可读取的原片绝对路径。
 * @returns 40 位小写十六进制 SHA1；失败时向调用方抛出文件 I/O 错误。
 */
export const hashExternalContentFile = async (filename: string): Promise<string> => {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
};

/**
 * 构建移动端同步用 checksum 投影，保持原有 bytea 协议结构不变。
 * 若当前用户存在同内容的其他资产，则退回路径指纹，防止错误归属。
 * @returns Kysely 别名为 checksum 的字节表达式。
 */
export const syncExternalContentChecksum = () => {
  if (!isExternalContentHashSyncEnabled()) {
    return sql<Buffer>`asset.checksum`.as('checksum');
  }
  return sql<Buffer>`COALESCE((
    SELECT decode(content_hash.value->>'sha1', 'hex')
    FROM asset_metadata AS content_hash
    WHERE content_hash."assetId" = asset.id
      AND content_hash.key = ${EXTERNAL_CONTENT_HASH_KEY}
      AND content_hash.value->>'published' = 'true'
      AND content_hash.value->>'sha1' ~ '^[a-f0-9]{40}$'
      AND asset."libraryId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM asset_metadata AS other_hash
        INNER JOIN asset AS other_asset ON other_asset.id = other_hash."assetId"
        WHERE other_hash.key = ${EXTERNAL_CONTENT_HASH_KEY}
          AND other_hash.value->>'published' = 'true'
          AND other_hash.value->>'sha1' = content_hash.value->>'sha1'
          AND other_asset."ownerId" = asset."ownerId"
          AND other_asset.id <> asset.id
          AND other_asset."deletedAt" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM asset AS uploaded
        WHERE uploaded."ownerId" = asset."ownerId"
          AND uploaded."libraryId" IS NULL
          AND uploaded."deletedAt" IS NULL
          AND uploaded.checksum = decode(content_hash.value->>'sha1', 'hex')
      )
    LIMIT 1
  ), asset.checksum)`.as('checksum');
};
