import { type RawBuilder, type SqlBool, sql } from 'kysely';

/**
 * 为搜索查询的 asset 别名构造全景条件，不写入元数据或改变权限范围。
 *
 * @returns INSP/INSV、明确等距柱状投影，或已核实 X5 JPG 导出规格对应的 SQL 布尔表达式。
 * 无 EXIF 的普通图片、没有投影证据的 MP4 不会仅因 2:1 比例被纳入。
 */
export const panoramaPredicate = (): RawBuilder<SqlBool> => sql<SqlBool>`(
  asset.type in ('IMAGE', 'VIDEO') and (
    (asset.type = 'IMAGE' and asset."originalFileName" ~* '[.]insp$') or
    (asset.type = 'VIDEO' and asset."originalFileName" ~* '[.]insv$') or
    exists (
      select 1 from asset_exif as panorama_exif
      where panorama_exif."assetId" = asset.id and (
        upper(panorama_exif."projectionType") = 'EQUIRECTANGULAR' or (
          nullif(panorama_exif."projectionType", '') is null and
          asset.type = 'IMAGE' and asset."originalFileName" ~* '[.]jpe?g$' and
          panorama_exif.make = 'Arashi Vision' and panorama_exif.model = 'Insta360 X5' and
          panorama_exif."exifImageWidth" = 11904 and panorama_exif."exifImageHeight" = 5952
        )
      )
    )
  )
)`;
