import sharp from 'sharp';
import z from 'zod';

/** 一个可照做的编辑步骤，change 描述参数起点，check 描述何时停止。 */
const step = z.object({ tool: z.string(), change: z.string(), check: z.string() });
const workflow = z.array(step).min(1).max(9);

/** 原片归一化选区。边缘羽化在渲染时处理，曝光为局部 EV。 */
const photoEditRegion = z.object({
  kind: z.enum(['mask', 'light']),
  shape: z.enum(['ellipse', 'rectangle']),
  target: z.string().min(1).max(60),
  x: z.number().min(0).max(97),
  y: z.number().min(0).max(97),
  width: z.number().min(3).max(100),
  height: z.number().min(3).max(100),
  exposure: z.number().min(-1).max(1),
});
const regions = z.array(photoEditRegion).max(4);

/** 建议、三个软件的操作流和 NAS 能直接应用的参数。 */
export const photoEditPlan = z.object({
  verdict: z.string(),
  score: z.number().int().min(0).max(10),
  diagnosis: z.string(),
  style: z.string(),
  mask: z.string(),
  curve: z.string(),
  recoverable: z.string(),
  limits: z.string(),
  lightroom: workflow,
  snapseed: workflow,
  photomator: workflow,
  render: z.object({
    // 裁剪按原始可用图像的宽高百分比定义，边界由服务端再验证。
    crop: z.object({
      left: z.number().min(0).max(30),
      top: z.number().min(0).max(30),
      right: z.number().min(0).max(30),
      bottom: z.number().min(0).max(30),
    }),
    exposure: z.number().min(-1).max(1),
    warmth: z.number().min(-0.15).max(0.15),
    contrast: z.number().min(-0.3).max(0.3),
    saturation: z.number().min(0.6).max(1.4),
    regions,
  }),
});

/** 比较原片、直接父版本与上传版，保留下一轮可执行的修改。 */
export const photoEditReview = z.object({
  verdict: z.string(),
  improvements: z.array(z.string()).max(6),
  regressions: z.array(z.string()).max(6),
  nextStep: z.string(),
});

export type PhotoEditPlan = z.infer<typeof photoEditPlan>;
export type PhotoEditReview = z.infer<typeof photoEditReview>;
type PhotoEditRender = Omit<PhotoEditPlan['render'], 'regions'> & { regions?: PhotoEditPlan['render']['regions'] };

/** 模型实际看到的 8 位 sRGB 图像数据；比例是 0 到 100 的百分比。 */
const photoEditHistogram = z.object({
  darkPercent: z.number(),
  middlePercent: z.number(),
  brightPercent: z.number(),
  blackClippedPercent: z.number(),
  whiteClippedPercent: z.number(),
});
export type PhotoEditHistogram = z.infer<typeof photoEditHistogram>;

/** 持久化报告按版本类型区分，包含实际模型输入的来源和测量。 */
export const photoEditReport = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('codex'),
    source: z.string(),
    original: photoEditHistogram,
    // 首版报告只记录全局参数，重开旧历史时继续读取原有成品。
    plan: photoEditPlan.extend({ render: photoEditPlan.shape.render.extend({ regions: regions.optional() }) }),
  }),
  z.object({
    kind: z.literal('upload'),
    source: z.string(),
    original: photoEditHistogram,
    parent: photoEditHistogram.nullable(),
    edited: photoEditHistogram,
    review: photoEditReview,
  }),
]);
export type PhotoEditReport = z.infer<typeof photoEditReport>;

/** @param image 经过定向和色彩空间转换的模型输入文件。@returns 按亮度分区及近黑、近白的像素比例。 */
export async function measurePhotoEditImage(image: string): Promise<PhotoEditHistogram> {
  const pixels = await sharp(image).removeAlpha().toColourspace('srgb').raw().toBuffer();
  let dark = 0;
  let middle = 0;
  let bright = 0;
  let blackClipped = 0;
  let whiteClipped = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (value < 85) dark++;
    else if (value < 170) middle++;
    else bright++;
    if (r <= 2 && g <= 2 && b <= 2) blackClipped++;
    if (r >= 253 && g >= 253 && b >= 253) whiteClipped++;
  }
  const total = pixels.length / 3;
  return {
    darkPercent: (dark * 100) / total,
    middlePercent: (middle * 100) / total,
    brightPercent: (bright * 100) / total,
    blackClippedPercent: (blackClipped * 100) / total,
    whiteClippedPercent: (whiteClipped * 100) / total,
  };
}

/** @param width 原片宽。@param height 原片高。@param crop 四边移除比例。@returns 标注与渲染共用的保留像素区域。 */
function cropBox(width: number, height: number, crop: PhotoEditRender['crop']) {
  const left = Math.floor((width * crop.left) / 100);
  const top = Math.floor((height * crop.top) / 100);
  return {
    left,
    top,
    width: width - left - Math.floor((width * crop.right) / 100),
    height: height - top - Math.floor((height * crop.bottom) / 100),
  };
}

/** @param width 原片宽。@param height 原片高。@param region 模型归一化选区。@returns 裁到原片边界内的像素框。 */
function regionBox(width: number, height: number, region: z.infer<typeof photoEditRegion>) {
  return {
    x: (width * region.x) / 100,
    y: (height * region.y) / 100,
    w: (width * Math.min(region.width, 100 - region.x)) / 100,
    h: (height * Math.min(region.height, 100 - region.y)) / 100,
  };
}

/** @param input 定向 sRGB 原片。@param regions 局部选区。@returns 用同一原片坐标应用羽化曝光后的 Sharp 输入。 */
async function applyRegionExposure(input: string, regions: NonNullable<PhotoEditRender['regions']>) {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  for (const region of regions) {
    if (region.exposure === 0) continue;
    const { x, y, w, h } = regionBox(width, height, region);
    for (let row = Math.floor(y); row < Math.ceil(y + h) && row < height; row++) {
      for (let column = Math.floor(x); column < Math.ceil(x + w) && column < width; column++) {
        const dx = Math.abs((2 * (column + 0.5 - x)) / w - 1);
        const dy = Math.abs((2 * (row + 0.5 - y)) / h - 1);
        const distance = region.shape === 'ellipse' ? Math.hypot(dx, dy) : Math.max(dx, dy);
        if (distance >= 1) continue;
        // 外侧 35% 羽化，在非线性 sRGB 上用 2.2 gamma 近似线性曝光。
        const feather = Math.min(1, (1 - distance) / 0.35);
        const gain = 2 ** ((region.exposure * feather * feather * (3 - 2 * feather)) / 2.2);
        const offset = (row * width + column) * channels;
        for (let channel = 0; channel < channels; channel++) {
          data[offset + channel] = Math.min(255, Math.round(data[offset + channel] * gain));
        }
      }
    }
  }
  return sharp(data, { raw: { width, height, channels } });
}

/**
@param input 已定向的 sRGB 输入，坐标与模型预览一致。
@param output 独立工作台下的 JPEG 路径。
@param adjustments 经 Schema 约束的裁剪、曝光、暖度、对比度和饱和度。
@returns JPEG 写完后完成。包含简化的局部曝光，暖度是 RGB 近似。
*/
export async function renderPhotoEdit(input: string, output: string, adjustments: PhotoEditRender): Promise<void> {
  const { width, height } = await sharp(input).metadata();
  const regions = adjustments.regions ?? [];
  const image = regions.some(({ exposure }) => exposure !== 0)
    ? await applyRegionExposure(input, regions)
    : sharp(input);
  const gain = 2 ** adjustments.exposure * (1 + adjustments.contrast);
  const offset = -128 * adjustments.contrast;
  await image
    .extract(cropBox(width, height, adjustments.crop))
    .linear([gain * (1 + adjustments.warmth), gain, gain * (1 - adjustments.warmth)], [offset, offset, offset])
    .modulate({ saturation: adjustments.saturation })
    .jpeg({ quality: 92 })
    .toFile(output);
}

/** @param input 原片预览。@param output 私有标注 PNG。@param render 与成品共用的参数。@returns 标注图写完后完成。 */
export async function renderPhotoEditAnnotation(
  input: string,
  output: string,
  render: PhotoEditPlan['render'],
): Promise<void> {
  const image = sharp(input);
  const { width, height } = await image.metadata();
  const { left, top, width: keptWidth, height: keptHeight } = cropBox(width, height, render.crop);
  const line = Math.max(1, Math.max(width, height) / 400);
  const font = Math.min(width / 20, height / 8, Math.max(5, Math.max(width, height) / 42));
  const marks: string[] = [];
  const labels: { x: number; y: number; w: number }[] = [];

  /** @param x 标签中心横坐标。@param rows 标签顶部候选位置。@param text 固定英文和数值图例。 */
  const label = (x: number, rows: number[], text: string) => {
    const w = (text.length * 0.65 + 1) * font;
    const center = Math.max(w / 2 + line, Math.min(width - w / 2 - line, x));
    const tops = rows.map((y) => Math.max(line, Math.min(height - 1.5 * font - line, y)));
    const top =
      tops.find((y) =>
        labels.every((other) => Math.abs(other.x - center) > (other.w + w) / 2 || Math.abs(other.y - y) > 1.6 * font),
      ) ?? tops[0];
    labels.push({ x: center, y: top, w });
    marks.push(
      `<rect x="${center - w / 2}" y="${top}" width="${w}" height="${1.5 * font}" rx="${font / 4}" fill="#111827" fill-opacity="0.92"/>`,
      `<text x="${center}" y="${top + 1.08 * font}" text-anchor="middle" fill="white">${text}</text>`,
    );
  };

  if (keptWidth !== width || keptHeight !== height) {
    // 镂空的遮罩只压暗裁掉的边缘，白色虚线标出成品保留区。
    marks.push(
      `<path fill="#030712" fill-opacity="0.58" fill-rule="evenodd" d="M0 0H${width}V${height}H0Z M${left} ${top}h${keptWidth}v${keptHeight}h${-keptWidth}Z"/>`,
      `<rect x="${left}" y="${top}" width="${keptWidth}" height="${keptHeight}" fill="none" stroke="white" stroke-width="${line}" stroke-dasharray="${3 * line} ${2 * line}"/>`,
    );
    label(left + keptWidth / 2, [top + line], 'CROP · KEEP');
  }

  for (const [index, region] of render.regions.entries()) {
    const { x, y, w, h } = regionBox(width, height, region);
    const color = region.kind === 'light' ? '#fbbf24' : '#67e8f9';
    const cx = x + w / 2;
    const style = `fill="${color}" fill-opacity="0.10" stroke="${color}" stroke-width="${line}"`;
    marks.push(
      region.shape === 'ellipse'
        ? `<ellipse cx="${cx}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${style}/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${style}/>`,
    );
    const ev = region.exposure === 0 ? '' : ` ${region.exposure > 0 ? '+' : ''}${region.exposure.toFixed(2)} EV`;
    label(
      cx,
      [y + h - font / 2, y - font, y + h + font, y - 2.5 * font],
      `${index + 1} ${region.kind.toUpperCase()}${ev}`,
    );
  }

  if (render.exposure !== 0) {
    const ev = `${render.exposure > 0 ? '+' : ''}${render.exposure.toFixed(2)} EV`;
    label(width / 2, [height - 2 * font, height - 4 * font], `GLOBAL ${ev}`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif" font-weight="bold" font-size="${font}">${marks.join('')}</svg>`;
  await image
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toFile(output);
}

/** @param name 输入角色。@param value 像素比例。@returns 供 Markdown 阅读的亮度测量行。 */
function histogramLine(name: string, value: PhotoEditHistogram): string {
  return `- ${name} · 暗部 ${value.darkPercent.toFixed(1)}% · 中间调 ${value.middlePercent.toFixed(1)}% · 亮部 ${value.brightPercent.toFixed(1)}% · 近黑 ${value.blackClippedPercent.toFixed(2)}% · 近白 ${value.whiteClippedPercent.toFixed(2)}%`;
}

/** @param report 已验证的报告。@returns 可独立下载的 Markdown，界面直接读同一份结构化数据。 */
export function photoEditMarkdown(report: PhotoEditReport): string {
  const lines = ['# 照片后期建议', '', `图像来源 ${report.source}`, ''];
  if (report.kind === 'upload') {
    const { verdict, improvements, regressions, nextStep } = report.review;
    lines.push(
      verdict,
      '',
      '## 有所改善',
      ...improvements.map((text) => `- ${text}`),
      '',
      '## 仍需调整',
      ...regressions.map((text) => `- ${text}`),
      '',
      '## 下一步',
      nextStep,
    );
  } else {
    const plan = report.plan;
    lines.push(
      `**${plan.verdict} · ${plan.score}/10**`,
      '',
      plan.diagnosis,
      '',
      `方向 ${plan.style}`,
      '',
      `蒙版 ${plan.mask}`,
      `曲线 ${plan.curve}`,
      `能改善 ${plan.recoverable}`,
      `上限 ${plan.limits}`,
    );
    for (const [title, steps] of [
      ['Lightroom Mobile', plan.lightroom],
      ['Snapseed', plan.snapseed],
      ['Photomator', plan.photomator],
    ] as const) {
      lines.push(
        '',
        `## ${title}`,
        ...steps.map(({ tool, change, check }, index) => `${index + 1}. **${tool}** — ${change}。检查 ${check}`),
      );
    }
    lines.push(
      '',
      '## 效果图参数',
      plan.render.regions
        ? '标注图保留完整画幅，成品应用裁剪、全局调整及标注选区的羽化曝光。曲线和修复按手工步骤执行。'
        : '此版本应用了全局调整。局部蒙版、曲线和修复按手工步骤执行。',
      '',
      '```json',
      JSON.stringify(plan.render, null, 2),
      '```',
    );
  }
  lines.push('', '## 输入图像亮度', histogramLine('原片输入', report.original));
  if (report.kind === 'upload') {
    if (report.parent) lines.push(histogramLine('父版本', report.parent));
    lines.push(histogramLine('上传版', report.edited));
  }
  return lines.join('\n') + '\n';
}
