import { AssetTypeEnum } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { assetFactory } from '@test-data/factories/asset-factory';
import { isX5InspAsset, readX5InspCalibration, selectPanoramaDimensions, X5InspError } from './x5-insp';

/**
 * 创建只包含检测与标定所需字段的轻量 INSP Blob，避免把私人样片提交进仓库。
 *
 * @param model EXIF 区域中用于相机型号校验的可见文本。
 * @param calibration 文件尾部的 `p2` 基础标定串；undefined 表示模拟缺失标定。
 * @returns 以 JPEG SOI 开头、可供元数据解析单元测试使用的新 Blob。
 */
const createInspFixture = (model: string, calibration?: string): Blob => {
  const header = new Uint8Array(16 * 1024);
  header.set([0xff, 0xd8]);
  header.set(new TextEncoder().encode(model), 128);
  return new Blob(calibration ? [header, calibration] : [header]);
};

describe(isX5InspAsset.name, () => {
  it('detects an image by its case-insensitive original filename', () => {
    const asset = assetFactory.build({ type: AssetTypeEnum.Image, originalFileName: 'IMG_2026_001.INSP' });

    expect(isX5InspAsset(asset)).toBe(true);
  });

  it('uses the original path when the filename does not expose the extension', () => {
    const asset = assetFactory.build({
      type: AssetTypeEnum.Image,
      originalFileName: 'IMG_2026_001',
      originalPath: '/external/Photos/IMG_2026_001.insp',
    });

    expect(isX5InspAsset(asset)).toBe(true);
  });

  it('does not intercept videos or ordinary images', () => {
    const video = assetFactory.build({ type: AssetTypeEnum.Video, originalFileName: 'clip.insp' });
    const image = assetFactory.build({ type: AssetTypeEnum.Image, originalFileName: 'photo.jpg' });

    expect(isX5InspAsset(video)).toBe(false);
    expect(isX5InspAsset(image)).toBe(false);
  });
});

describe(selectPanoramaDimensions.name, () => {
  it('keeps a 2:1 output within source and GPU limits', () => {
    expect(selectPanoramaDimensions(11_904, 5952, 16_384, 7680)).toEqual({ width: 7680, height: 3840 });
    expect(selectPanoramaDimensions(11_904, 5952, 4096, 7680)).toEqual({ width: 4096, height: 2048 });
  });

  it('rejects layouts that are not side-by-side dual fisheye images', () => {
    expect(() => selectPanoramaDimensions(4000, 3000, 8192, 4096)).toThrowError(X5InspError);
  });
});

describe(readX5InspCalibration.name, () => {
  it('normalizes the X5 p2 lens centers and radii for WebGL sampling', async () => {
    const calibration =
      'p2_2657.652_2695.480_2694.280_-1.515_-0.266_88.383_' +
      '2658.302_8056.730_2704.110_1.590_-0.218_90.600_10752_5376_11378';
    const result = await readX5InspCalibration(createInspFixture('Arashi Vision Insta360 X5', calibration));

    expect(result.frontLens.center[0]).toBeCloseTo(2695.48 / 10_752);
    expect(result.frontLens.center[1]).toBeCloseTo(1 - 2657.652 / 5376);
    expect(result.frontLens.radius).toEqual([2694.28 / 10_752, 2694.28 / 5376]);
    expect(result.backLens.center[0]).toBeCloseTo(8056.73 / 10_752);
    expect(result.backLens.center[1]).toBeCloseTo(1 - 2658.302 / 5376);
    expect(result.backLens.radius).toEqual([2704.11 / 10_752, 2704.11 / 5376]);
  });

  it('rejects INSP files from another camera before attempting WebGL rendering', async () => {
    const source = createInspFixture('Arashi Vision Insta360 X4');

    await expect(readX5InspCalibration(source)).rejects.toMatchObject({ reason: 'unsupported-camera' });
  });

  it('rejects X5 files whose basic lens calibration is unavailable', async () => {
    const source = createInspFixture('Arashi Vision Insta360 X5');

    await expect(readX5InspCalibration(source)).rejects.toMatchObject({ reason: 'missing-calibration' });
  });
});
