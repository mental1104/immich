import { AssetTypeEnum } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { assetFactory } from '@test-data/factories/asset-factory';
import { isX5InspAsset, selectPanoramaDimensions, X5InspError } from './x5-insp';

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
    expect(selectPanoramaDimensions(11_968, 5984, 16_384, 7680)).toEqual({ width: 7680, height: 3840 });
    expect(selectPanoramaDimensions(11_968, 5984, 4096, 7680)).toEqual({ width: 4096, height: 2048 });
  });

  it('rejects layouts that are not side-by-side dual fisheye images', () => {
    expect(() => selectPanoramaDimensions(4000, 3000, 8192, 4096)).toThrowError(X5InspError);
  });
});
