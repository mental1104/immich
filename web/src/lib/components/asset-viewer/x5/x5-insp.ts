import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';

/** X5 INSP 资源识别、错误分类与输出尺寸计算等不依赖浏览器图形 API 的基础能力。 */

const INSP_EXTENSION = '.insp';
const EXPECTED_DUAL_FISHEYE_ASPECT_RATIO = 2;
const ASPECT_RATIO_TOLERANCE = 0.2;
const MIN_PANORAMA_WIDTH = 2048;
const MAX_PANORAMA_WIDTH = 8192;
const JPEG_START_MARKER = new Uint8Array([0xff, 0xd8]);
const X5_MODEL_SIGNATURE = 'Insta360 X5';
const HEADER_SCAN_BYTES = 16 * 1024;
const CALIBRATION_SCAN_CHUNK_BYTES = 512 * 1024;
const CALIBRATION_SCAN_OVERLAP_BYTES = 512;
const NUMBER_PATTERN = String.raw`-?\d+(?:\.\d+)?`;
const P2_CALIBRATION_PATTERN = new RegExp(
  `p2_(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_` +
    `(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_` +
    `(${NUMBER_PATTERN})_(${NUMBER_PATTERN})_`,
);

/** X5 INSP 增强链路允许上报给适配层的稳定失败类别，不包含底层驱动或私人文件信息。 */
export type X5InspFailureReason =
  | 'decode-failed'
  | 'invalid-image'
  | 'missing-calibration'
  | 'render-failed'
  | 'unsupported-browser'
  | 'unsupported-camera'
  | 'unsupported-layout';

/** X5 Viewer 请求 Immich 恢复原生 Viewer 时携带的最小上下文。 */
export type X5InspFallback = {
  /** 发生失败的 Immich 资源 ID，用于避免异步结果影响已经切换到的资源。 */
  assetId: string;
  /** 供控制台诊断和测试断言使用的失败类别，不直接展示给用户。 */
  reason: X5InspFailureReason;
};

/** 客户端临时等距柱状预览的像素尺寸。 */
export type PanoramaDimensions = {
  /** 输出宽度，单位为像素且始终为偶数。 */
  width: number;
  /** 输出高度，单位为像素且始终等于宽度的一半。 */
  height: number;
};

/** 单个 X5 鱼眼镜头在整张 INSP 纹理中的归一化采样范围，V 坐标已转换为 WebGL 原点方向。 */
export type X5InspLensCalibration = {
  /** 镜头圆心的 `[u, v]` 坐标，每项范围为 0 到 1。 */
  center: readonly [number, number];
  /** 镜头有效圆半径分别占整张纹理宽、高的比例。 */
  radius: readonly [number, number];
};

/** 从 X5 `p2` 元数据提取的双镜头基础标定；不包含官方畸变和光流拼接参数。 */
export type X5InspCalibration = {
  /** 原图左半部分镜头的归一化采样参数。 */
  frontLens: X5InspLensCalibration;
  /** 原图右半部分镜头的归一化采样参数。 */
  backLens: X5InspLensCalibration;
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
   * @param options 可选的标准 ErrorOptions；其中 cause 仅用于保留错误链，不直接展示给用户。
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
 * 在 INSP 二进制数据中分块查找 X5 `p2` 基础标定串。
 *
 * @param source 已通过 JPEG 与 X5 型号校验的原始 INSP Blob。
 * @returns 找到时返回正则匹配结果；扫描完整个文件仍未找到时返回 undefined。
 */
const findP2Calibration = async (source: Blob): Promise<RegExpMatchArray | undefined> => {
  const decoder = new TextDecoder('windows-1252');
  let overlap = '';

  for (let offset = 0; offset < source.size; offset += CALIBRATION_SCAN_CHUNK_BYTES) {
    const end = Math.min(offset + CALIBRATION_SCAN_CHUNK_BYTES, source.size);
    const chunk = decoder.decode(await source.slice(offset, end).arrayBuffer());
    const searchableText = overlap + chunk;
    const match = searchableText.match(P2_CALIBRATION_PATTERN);
    if (match) {
      return match;
    }

    // 标定串可能跨越 Blob 分块边界；保留足够的尾部文本与下一块拼接后再匹配。
    overlap = searchableText.slice(-CALIBRATION_SCAN_OVERLAP_BYTES);
  }

  return undefined;
};

/**
 * 把 `p2` 中基于标定分辨率的像素坐标转换为 WebGL 纹理坐标。
 *
 * @param centerY 镜头圆心相对标定图像顶部的 Y 坐标，单位为像素。
 * @param centerX 镜头圆心相对标定图像左侧的 X 坐标，单位为像素。
 * @param radius 镜头有效圆半径，单位为像素。
 * @param calibrationWidth `p2` 标定图像宽度，单位为像素。
 * @param calibrationHeight `p2` 标定图像高度，单位为像素。
 * @returns 可直接作为 shader uniform 使用的归一化圆心和椭圆半径。
 */
const normalizeLensCalibration = (
  centerY: number,
  centerX: number,
  radius: number,
  calibrationWidth: number,
  calibrationHeight: number,
): X5InspLensCalibration => ({
  center: [centerX / calibrationWidth, 1 - centerY / calibrationHeight],
  radius: [radius / calibrationWidth, radius / calibrationHeight],
});

/**
 * 验证原文件由 X5 生成，并读取两个鱼眼镜头的基础标定。
 * 读取过程按固定大小分块，不会额外复制完整的高分辨率 INSP 文件。
 *
 * @param source Immich 原文件接口返回的完整 INSP Blob。
 * @returns 两个镜头相对于整张图片的归一化圆心和半径。
 * @throws {X5InspError} 文件不是 JPEG、型号不是 X5、缺少标定串或标定值越界时抛出。
 */
export const readX5InspCalibration = async (source: Blob): Promise<X5InspCalibration> => {
  if (source.size < JPEG_START_MARKER.length) {
    throw new X5InspError('invalid-image', 'INSP file is empty');
  }

  const header = new Uint8Array(await source.slice(0, Math.min(HEADER_SCAN_BYTES, source.size)).arrayBuffer());
  if (JPEG_START_MARKER.some((value, index) => header[index] !== value)) {
    throw new X5InspError('invalid-image', 'INSP file is not a JPEG container');
  }

  const headerText = new TextDecoder('windows-1252').decode(header);
  if (!headerText.includes(X5_MODEL_SIGNATURE)) {
    throw new X5InspError('unsupported-camera', 'INSP file was not created by an Insta360 X5');
  }

  const match = await findP2Calibration(source);
  if (!match) {
    throw new X5InspError('missing-calibration', 'X5 INSP file does not contain a supported p2 calibration');
  }

  const values = match.slice(1).map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new X5InspError('missing-calibration', 'X5 p2 calibration contains a non-finite value');
  }

  // `p2` 每个镜头依次保存 centerY、centerX、radius 和三个姿态角，最后保存标定图像宽高。
  const calibrationWidth = values[12];
  const calibrationHeight = values[13];
  const frontCenterY = values[0];
  const frontCenterX = values[1];
  const frontRadius = values[2];
  const backCenterY = values[6];
  const backCenterX = values[7];
  const backRadius = values[8];
  const isInvalidCalibration =
    calibrationWidth <= 0 ||
    calibrationHeight <= 0 ||
    frontRadius <= 0 ||
    backRadius <= 0 ||
    frontCenterX <= 0 ||
    frontCenterX >= calibrationWidth / 2 ||
    backCenterX <= calibrationWidth / 2 ||
    backCenterX >= calibrationWidth ||
    frontCenterY <= 0 ||
    frontCenterY >= calibrationHeight ||
    backCenterY <= 0 ||
    backCenterY >= calibrationHeight;
  if (isInvalidCalibration) {
    throw new X5InspError('missing-calibration', 'X5 p2 calibration is outside the source image bounds');
  }

  return {
    frontLens: normalizeLensCalibration(frontCenterY, frontCenterX, frontRadius, calibrationWidth, calibrationHeight),
    backLens: normalizeLensCalibration(backCenterY, backCenterX, backRadius, calibrationWidth, calibrationHeight),
  };
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
