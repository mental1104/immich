import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { measurePhotoEditImage, renderPhotoEdit } from 'src/utils/photo-edit-advice.js';

/** 效果图使用真实像素，验证直方图及可执行参数作用于实际生成的文件。 */
describe('Photo Edit Advice rendering', () => {
  /** 校验 JPEG 裁剪与原片不变，亮度统计必须反映实际输入。 */
  it('measures tones and renders a cropped, brighter copy', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'immich-photo-edit-unit-'));
    try {
      const source = path.join(dir, 'source.png');
      const output = path.join(dir, 'result.jpg');
      await sharp({ create: { width: 100, height: 80, channels: 3, background: '#404040' } })
        .png()
        .toFile(source);
      const before = await measurePhotoEditImage(source);
      expect(before).toMatchObject({ darkPercent: 100, middlePercent: 0, brightPercent: 0 });
      await renderPhotoEdit(source, output, {
        crop: { left: 10, top: 0, right: 10, bottom: 0 },
        exposure: 1,
        contrast: 0,
        saturation: 1,
        warmth: 0,
      });
      expect(await sharp(output).metadata()).toMatchObject({ width: 80, height: 80, format: 'jpeg' });
      expect(await measurePhotoEditImage(output)).toMatchObject({ middlePercent: 100 });
      expect(await measurePhotoEditImage(source)).toEqual(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
