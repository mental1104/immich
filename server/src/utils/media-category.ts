import { type RawBuilder, type SqlBool, sql } from 'kysely';
import type { MediaResolution } from 'src/dtos/search.dto.js';

/** 按 Apple 设备信息和常见 16:9 / 4:3 规格归类视频，兼容横竖方向及缩放后的同画幅视频。 */
export const phoneVideoPredicate = (): RawBuilder<SqlBool> => sql<SqlBool>`coalesce((
  asset.type = 'VIDEO' and asset.width > 0 and asset.height > 0 and (
    asset.width::bigint * 9 = asset.height::bigint * 16 or
    asset.width::bigint * 16 = asset.height::bigint * 9 or
    asset.width::bigint * 3 = asset.height::bigint * 4 or
    asset.width::bigint * 4 = asset.height::bigint * 3
  ) and exists (
    select 1 from asset_exif as phone_exif where phone_exif."assetId" = asset.id and (
      btrim(phone_exif.make) ilike 'Apple%' or btrim(phone_exif.model) ilike 'Apple%'
    )
  )
), false)`;

/** 仅采用用户确认的纵向截图尺寸，不把其他屏幕规格或横向图片一并推断为截图。 */
export const screenshotPredicate = (): RawBuilder<SqlBool> => sql<SqlBool>`coalesce((
  asset.type = 'IMAGE' and asset.width = 1179 and asset.height = 2556
), false)`;

/** 按用户指定的尺寸归类 Delta GBA游戏截图。 */
export const deltaScreenshotPredicate = (): RawBuilder<SqlBool> => sql<SqlBool>`coalesce((
  asset.type = 'IMAGE' and (asset.width = 1680 and asset.height = 1120)
), false)`;

/** 按用户指定的尺寸归类 Steam游戏截图。 */
export const steamScreenshotPredicate = (): RawBuilder<SqlBool> => sql<SqlBool>`coalesce((
  asset.type = 'IMAGE' and (asset.width = 2560 and asset.height = 1440)
), false)`;

/** 按用户指定的两个横向尺寸和 Nintendo 设备信息归类 Switch 游戏机截图，不限制镜头。 */
export const switchScreenshotPredicate = (): RawBuilder<SqlBool> => sql<SqlBool>`coalesce((
  asset.type = 'IMAGE' and (
    (asset.width = 1280 and asset.height = 720) or
    (asset.width = 1920 and asset.height = 1080)
  ) and exists (
    select 1 from asset_exif as switch_exif where switch_exif."assetId" = asset.id and (
      btrim(switch_exif.make) ilike 'Nintendo co., ltd' or btrim(switch_exif.model) ilike 'Nintendo co., ltd'
    )
  )
), false)`;

/** 按用户指定的尺寸归类 3DS游戏截图。 */
export const nintendo3dsScreenshotPredicate = (): RawBuilder<SqlBool> => sql<SqlBool>`coalesce((
  asset.type = 'IMAGE' and (asset.width = 400 and asset.height = 240)
), false)`;

const resolutionDimensions: Record<MediaResolution, readonly (readonly [number, number])[]> = {
  '720p': [[1280, 720]],
  '1080p': [[1920, 1080]],
  '2k': [[2560, 1440]],
  '4k': [
    [3840, 2160],
    [4096, 2160],
  ],
};

/** 分辨率独立于来源分类，照片和视频均按精确尺寸匹配，兼容横竖方向。 */
export const resolutionPredicate = (resolution: MediaResolution): RawBuilder<SqlBool> => {
  const sizes = resolutionDimensions[resolution].map(
    ([width, height]) => sql<SqlBool>`(
    (asset.width = ${width} and asset.height = ${height}) or
    (asset.width = ${height} and asset.height = ${width})
  )`,
  );
  return sql<SqlBool>`coalesce((asset.type in ('IMAGE', 'VIDEO') and (${sql.join(sizes, sql` or `)})), false)`;
};
