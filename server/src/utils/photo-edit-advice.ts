import sharp from 'sharp';
import z from 'zod';

/** 一个可照做的编辑步骤，change 描述参数起点，check 描述何时停止。 */
const step = z.object({ tool: z.string(), change: z.string(), check: z.string() });
const workflow = z.array(step).min(1).max(9);

/** 建议和三个软件的操作流，加上 NAS 渲染器确实支持的全局参数。 */
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
    plan: photoEditPlan,
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

/**
 * @param input 已定向的 sRGB 输入，坐标与模型预览一致。
 * @param output 独立工作台下的 JPEG 路径。
 * @param adjustments 经 Schema 约束的裁剪、曝光、暖度、对比度和饱和度。
 * @returns JPEG 写完后完成。暖度是 RGB 近似，效果图不包含手工蒙版、曲线或修复。
 */
export async function renderPhotoEdit(
  input: string,
  output: string,
  adjustments: PhotoEditPlan['render'],
): Promise<void> {
  const { width, height } = await sharp(input).metadata();
  const crop = adjustments.crop;
  const left = Math.floor((width * crop.left) / 100);
  const top = Math.floor((height * crop.top) / 100);
  const gain = 2 ** adjustments.exposure * (1 + adjustments.contrast);
  const offset = -128 * adjustments.contrast;
  await sharp(input)
    .extract({
      left,
      top,
      width: width - left - Math.floor((width * crop.right) / 100),
      height: height - top - Math.floor((height * crop.bottom) / 100),
    })
    .linear([gain * (1 + adjustments.warmth), gain, gain * (1 - adjustments.warmth)], [offset, offset, offset])
    .modulate({ saturation: adjustments.saturation })
    .jpeg({ quality: 92 })
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
      '仅应用全局调整，局部蒙版、曲线和修复按上面的手工流程执行。',
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
