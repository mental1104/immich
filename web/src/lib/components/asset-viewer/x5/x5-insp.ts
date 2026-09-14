import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';

/** X5 INSP 资源识别、错误分类与输出尺寸计算等不依赖浏览器图形 API 的基础能力。 */

const INSP_EXTENSION = '.insp';
const EXPECTED_DUAL_FISHEYE_ASPECT_RATIO = 2;
const ASPECT_RATIO_TOLERANCE = 0.2;
const MIN_PANORAMA_WIDTH = 2048;
const MAX_PANORAMA_WIDTH = 8192;

export type X5InspFailureReason =
  'decode-failed' | 'invalid-image' | 'render-failed' | 'unsupported-browser' | 'unsupported-layout';

export type X5InspFallback = {
  assetId: string;
  reason: X5InspFailureReason;
};

export type PanoramaDimensions = {
  width: number;
  height: number;
};

/**
 * 表示客户端 X5 INSP 增强链路中的可预期失败。
 * `reason` 供上层记录诊断信息；用户界面只显示弱化后的统一降级提示。
 */
export class X5InspError extends Error {
  /**
   * 创建一个可分类的 INSP 渲染错误。
   *
   * @param reason 稳定的失败类别，不能包含文件名或底层驱动信息。
   * @param message 供开发者控制台诊断的具体说明。
   * @param cause 原始异常；仅用于保留错误链，不直接展示给用户。
   */
  constructor(
    public readonly reason: X5InspFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'X5InspError';
  }
}

/**
 * 判断资源是否应尝试进入 X5 INSP 客户端增强链路。
 *
 * @param asset Immich 返回的资源；只有图片类型且原文件名或路径以 `.insp` 结尾时才返回 true。
 * @returns 候选 INSP 图片返回 true；其他资源返回 false，并继续使用 Immich 原 Viewer。
 */
export const isX5InspAsset = (asset: AssetResponseDto): boolean => {
  if (asset.type !== AssetTypeEnum.Image) {
    return false;
  }

  return [asset.originalFileName, asset.originalPath].some((value) => value?.toLowerCase().endsWith(INSP_EXTENSION));
};

/**
 * 为浏览器端生成的等距柱状预览选择尺寸。
 *
 * @param sourceWidth 原始双鱼眼图片宽度，单位为像素。
 * @param sourceHeight 原始双鱼眼图片高度，单位为像素。
 * @param gpuLimit WebGL 同时允许的最大纹理及渲染缓冲区边长，单位为像素。
 * @param preferredWidth 根据当前视口估算的期望全景宽度，单位为像素。
 * @returns 宽高比固定为 2:1、宽度为偶数且不超过源图与 GPU 限制的尺寸。
 * @throws {X5InspError} 图片尺寸无效或不符合左右双鱼眼布局时抛出。
 */
export const selectPanoramaDimensions = (
  sourceWidth: number,
  sourceHeight: number,
  gpuLimit: number,
  preferredWidth: number,
): PanoramaDimensions => {
  if (sourceWidth <= 0 || sourceHeight <= 0 || gpuLimit <= 0) {
    throw new X5InspError('invalid-image', 'INSP image or WebGL dimension is invalid');
  }

  const sourceAspectRatio = sourceWidth / sourceHeight;
  if (Math.abs(sourceAspectRatio - EXPECTED_DUAL_FISHEYE_ASPECT_RATIO) > ASPECT_RATIO_TOLERANCE) {
    throw new X5InspError(
      'unsupported-layout',
      `Expected a side-by-side dual-fisheye image, received ${sourceWidth}x${sourceHeight}`,
    );
  }

  const requestedWidth = Math.min(Math.max(Math.round(preferredWidth), MIN_PANORAMA_WIDTH), MAX_PANORAMA_WIDTH);
  const boundedWidth = Math.min(requestedWidth, sourceWidth, gpuLimit);
  const width = Math.floor(boundedWidth / 2) * 2;
  if (width < 2) {
    throw new X5InspError('invalid-image', 'INSP image is too small to render');
  }

  return { width, height: width / 2 };
};

/**
 * 将任意异常归一化为稳定的增强失败类别。
 *
 * @param error 渲染链路捕获到的未知异常。
 * @returns 已分类错误保留其 reason；其他异常统一视为 render-failed。
 */
export const getX5InspFailureReason = (error: unknown): X5InspFailureReason =>
  error instanceof X5InspError ? error.reason : 'render-failed';
