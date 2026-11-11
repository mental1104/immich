import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  measurePhotoEditImage,
  photoEditReport,
  renderPhotoEdit,
  renderPhotoEditAnnotation,
} from 'src/utils/photo-edit-advice.js';

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

  /** 标注保留原片画幅，成品在裁剪后只提亮被圈出的区域。 */
  it('shares crop and region geometry between separate annotation and final files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'immich-photo-edit-unit-'));
    try {
      const source = path.join(dir, 'source.png');
      const annotation = path.join(dir, 'annotation.png');
      const final = path.join(dir, 'final.jpg');
      await sharp({ create: { width: 320, height: 200, channels: 3, background: '#606060' } })
        .png()
        .toFile(source);
      const render = {
        crop: { left: 25, top: 0, right: 0, bottom: 0 },
        exposure: 0,
        contrast: 0,
        saturation: 1,
        warmth: 0,
        regions: [
          { kind: 'light', shape: 'ellipse', target: '主体', x: 50, y: 25, width: 30, height: 50, exposure: 1 },
        ],
      } as const;
      const adjustments = { ...render, regions: [...render.regions] };
      await renderPhotoEditAnnotation(source, annotation, adjustments);
      await renderPhotoEdit(source, final, adjustments);
      expect(await sharp(annotation).metadata()).toMatchObject({ width: 320, height: 200, format: 'png' });
      expect(await sharp(final).metadata()).toMatchObject({ width: 240, height: 200, format: 'jpeg' });
      /** @param file 待读取的图。@param left 横坐标。@param top 纵坐标。@returns 像素的红色通道值。 */
      const red = async (file: string, left: number, top: number) => {
        const pixel = await sharp(file).extract({ left, top, width: 1, height: 1 }).raw().toBuffer();
        return pixel[0];
      };
      expect(await red(annotation, 20, 170)).toBeLessThan(60);
      expect(await red(annotation, 110, 170)).toBe(96);
      expect(await red(final, 128, 100)).toBeGreaterThan(125);
      expect(await red(final, 40, 100)).toBeCloseTo(96, 0);
      expect(await red(source, 208, 100)).toBe(96);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** 已落盘的首版报告没有局部选区字段，仍能被解析和展示。 */
  it('keeps reports without annotation data readable', () => {
    const original = {
      darkPercent: 0,
      middlePercent: 100,
      brightPercent: 0,
      blackClippedPercent: 0,
      whiteClippedPercent: 0,
    };
    const steps = [{ tool: 'Crop', change: 'Keep', check: 'Edges' }];
    const report = photoEditReport.parse({
      kind: 'codex',
      source: 'original',
      original,
      plan: {
        verdict: '',
        score: 7,
        diagnosis: '',
        style: '',
        mask: '',
        curve: '',
        recoverable: '',
        limits: '',
        lightroom: steps,
        snapseed: steps,
        photomator: steps,
        render: { crop: { left: 0, top: 0, right: 0, bottom: 0 }, exposure: 0, warmth: 0, contrast: 0, saturation: 1 },
      },
    });
    expect(report.kind === 'codex' && report.plan.render.regions).toBeUndefined();
  });
});
