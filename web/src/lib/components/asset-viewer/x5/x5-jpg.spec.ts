import { AssetTypeEnum } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { ProjectionType } from '$lib/constants';
import { assetFactory } from '@test-data/factories/asset-factory';
import { isPanoramaImage } from './x5-jpg';

/** 验证元数据优先及无 GPano 回退边界；仅使用合成 EXIF，不包含私人样片。 */
describe(isPanoramaImage.name, () => {
  const asset = assetFactory.build({
    type: AssetTypeEnum.Image,
    originalFileName: 'export.JPG',
    exifInfo: {
      make: 'Arashi Vision',
      model: 'Insta360 X5',
      exifImageWidth: 11_904,
      exifImageHeight: 5952,
    },
  });

  /** 已核实的导出规格在没有投影元数据时进入原有球形查看器。 */
  it('recognizes the verified X5 JPEG export without GPano', () => {
    expect(isPanoramaImage(asset)).toBe(true);
    expect(isPanoramaImage({ ...asset, originalFileName: 'export.jpeg' })).toBe(true);
  });

  /** 显式投影无需相机或尺寸启发式；其他投影不被覆盖。 */
  it('prefers explicit projection metadata', () => {
    expect(isPanoramaImage({ ...asset, exifInfo: { projectionType: ProjectionType.EQUIRECTANGULAR } })).toBe(true);
    expect(isPanoramaImage({ ...asset, exifInfo: { ...asset.exifInfo, projectionType: 'FISHEYE' } })).toBe(false);
  });

  /** 文件类型和资源类型不能被相同的相机及尺寸误判。 */
  it('does not intercept INSP, PNG or video assets', () => {
    expect(isPanoramaImage({ ...asset, originalFileName: 'source.insp' })).toBe(false);
    expect(isPanoramaImage({ ...asset, originalFileName: 'export.png' })).toBe(false);
    expect(isPanoramaImage({ ...asset, type: AssetTypeEnum.Video })).toBe(false);
  });

  /** 每次移除一项识别证据，确保普通 2:1 图片和缺失 EXIF 均保留普通查看器。 */
  it('requires all fallback evidence', () => {
    expect(isPanoramaImage({ ...asset, exifInfo: undefined })).toBe(false);
    expect(isPanoramaImage({ ...asset, exifInfo: { ...asset.exifInfo, make: 'Other' } })).toBe(false);
    expect(isPanoramaImage({ ...asset, exifInfo: { ...asset.exifInfo, model: 'Insta360 X4' } })).toBe(false);
    expect(
      isPanoramaImage({ ...asset, exifInfo: { ...asset.exifInfo, exifImageWidth: 7680, exifImageHeight: 3840 } }),
    ).toBe(false);
    expect(isPanoramaImage({ ...asset, exifInfo: { ...asset.exifInfo, exifImageHeight: 6000 } })).toBe(false);
  });
});
