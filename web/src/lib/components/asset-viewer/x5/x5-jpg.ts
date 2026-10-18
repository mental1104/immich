import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
import { ProjectionType } from '$lib/constants';

/**
 * 为球形照片查看器识别投影元数据，或已核实的 X5 高分辨率 JPG 导出规格。
 *
 * @param asset 已加载 EXIF 的资源；不修改资源或服务端元数据。
 * @returns 视频、显式其他投影或未满足受限导出规格时为 false。
 */
export const isPanoramaImage = (asset: AssetResponseDto): boolean => {
  if (asset.type !== AssetTypeEnum.Image) {
    return false;
  }

  const exif = asset.exifInfo;
  // 可靠投影元数据优先；不以相机型号覆盖显式的其他投影。
  if (exif?.projectionType) {
    return exif.projectionType === ProjectionType.EQUIRECTANGULAR;
  }

  // 已核实的无 GPano 样本为此规格的拼接 JPG；不推广到所有 2:1 图片或 INSP 双鱼眼。
  return (
    /\.jpe?g$/i.test(asset.originalFileName) &&
    exif?.make === 'Arashi Vision' &&
    exif.model === 'Insta360 X5' &&
    exif.exifImageWidth === 11_904 &&
    exif.exifImageHeight === 5952
  );
};
