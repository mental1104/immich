import { X5InspError, type PanoramaDimensions, selectPanoramaDimensions } from './x5-insp';

/** 使用 WebGL2 在访问客户端内存中把左右双鱼眼 INSP 转为临时等距柱状预览。 */

const JPEG_START_MARKER = new Uint8Array([0xff, 0xd8]);

const VERTEX_SHADER = `#version 300 es
precision highp float;

const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

out vec2 panoramaUv;

void main() {
  vec2 position = POSITIONS[gl_VertexID];
  panoramaUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

const float PI = 3.14159265358979323846;

uniform sampler2D sourceImage;

in vec2 panoramaUv;
out vec4 outputColor;

vec2 directionToLensUv(vec3 direction, bool frontLens) {
  // 后置镜头朝向 -Z，其局部 X 轴与前置镜头相反，翻转后才能保持接缝两侧方向连续。
  vec3 localDirection = frontLens
    ? direction
    : vec3(-direction.x, direction.y, -direction.z);
  float theta = acos(clamp(localDirection.z, -1.0, 1.0));
  float radius = theta / PI;
  float phi = atan(localDirection.y, localDirection.x);
  vec2 lensUv = vec2(0.5) + radius * vec2(cos(phi), sin(phi));
  float lensOffset = frontLens ? 0.0 : 1.0;
  return vec2((lensUv.x + lensOffset) * 0.5, lensUv.y);
}

void main() {
  float longitude = (panoramaUv.x - 0.5) * 2.0 * PI;
  float latitude = (panoramaUv.y - 0.5) * PI;
  float latitudeRadius = cos(latitude);
  vec3 direction = vec3(
    latitudeRadius * sin(longitude),
    sin(latitude),
    latitudeRadius * cos(longitude)
  );
  bool frontLens = direction.z >= 0.0;
  outputColor = texture(sourceImage, directionToLensUv(direction, frontLens));
}
`;

export type X5InspRenderOptions = {
  preferredWidth: number;
  jpegQuality?: number;
};

/**
 * 编译单个 WebGL shader，并把驱动日志转换为可降级的错误。
 *
 * @param gl 当前渲染任务独占的 WebGL2 上下文。
 * @param type shader 类型，只允许 VERTEX_SHADER 或 FRAGMENT_SHADER。
 * @param source GLSL ES 3.00 源码。
 * @returns 已成功编译且仍归当前 WebGL 上下文所有的 shader。
 * @throws {X5InspError} 浏览器或显卡驱动拒绝编译时抛出 render-failed。
 */
const compileShader = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new X5InspError('render-failed', 'Unable to allocate a WebGL shader');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Unknown shader compilation error';
    gl.deleteShader(shader);
    throw new X5InspError('render-failed', message);
  }

  return shader;
};

/**
 * 链接双鱼眼转换程序。
 *
 * @param gl 当前渲染任务独占的 WebGL2 上下文。
 * @param vertexShader 已编译的顶点 shader。
 * @param fragmentShader 已编译的片段 shader。
 * @returns 可立即用于绘制全屏三角形的 program。
 * @throws {X5InspError} 链接失败时抛出 render-failed。
 */
const linkProgram = (
  gl: WebGL2RenderingContext,
  vertexShader: WebGLShader,
  fragmentShader: WebGLShader,
): WebGLProgram => {
  const program = gl.createProgram();
  if (!program) {
    throw new X5InspError('render-failed', 'Unable to allocate a WebGL program');
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'Unknown WebGL program link error';
    gl.deleteProgram(program);
    throw new X5InspError('render-failed', message);
  }

  return program;
};

/**
 * 验证原文件至少是浏览器能够尝试解码的 JPEG 容器。
 *
 * @param source Immich 原文件接口返回的 Blob。
 * @returns 校验成功时无返回值。
 * @throws {X5InspError} 文件过短或缺少 JPEG SOI 标记时抛出 invalid-image。
 */
const assertJpegContainer = async (source: Blob): Promise<void> => {
  if (source.size < JPEG_START_MARKER.length) {
    throw new X5InspError('invalid-image', 'INSP file is empty');
  }

  const header = new Uint8Array(await source.slice(0, JPEG_START_MARKER.length).arrayBuffer());
  if (header.some((value, index) => value !== JPEG_START_MARKER[index])) {
    throw new X5InspError('invalid-image', 'INSP file is not a JPEG container');
  }
};

/**
 * 解码 INSP 中的 JPEG 图像；重新声明 MIME 可兼容返回专有 MIME 的服务端。
 *
 * @param source 已通过 JPEG 头校验的原始 INSP Blob。
 * @returns 新建的 ImageBitmap，调用者必须在渲染结束后 close。
 * @throws {X5InspError} 浏览器缺少 createImageBitmap 或图片数据无法解码时抛出。
 */
const decodeInsp = async (source: Blob): Promise<ImageBitmap> => {
  if (typeof createImageBitmap !== 'function') {
    throw new X5InspError('unsupported-browser', 'createImageBitmap is unavailable');
  }

  try {
    const jpegSource = source.slice(0, source.size, 'image/jpeg');
    return await createImageBitmap(jpegSource, { imageOrientation: 'from-image' });
  } catch (error) {
    throw new X5InspError('decode-failed', 'Browser failed to decode the INSP JPEG payload', { cause: error });
  }
};

/**
 * 在原图超过 GPU 纹理限制时创建缩小副本。
 *
 * @param source 已解码的原始图像。
 * @param maxTextureSize 当前 WebGL 上下文支持的最大纹理边长。
 * @returns 原图可直接上传时返回 ImageBitmap；否则返回按比例缩小的临时 Canvas。
 * @throws {X5InspError} 无法创建 2D 上下文时抛出 render-failed。
 */
const fitSourceToTexture = (source: ImageBitmap, maxTextureSize: number): ImageBitmap | HTMLCanvasElement => {
  if (source.width <= maxTextureSize && source.height <= maxTextureSize) {
    return source;
  }

  const scale = Math.min(maxTextureSize / source.width, maxTextureSize / source.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(source.width * scale));
  canvas.height = Math.max(1, Math.floor(source.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    throw new X5InspError('render-failed', 'Unable to create a staging 2D canvas');
  }
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
};

/**
 * 将 WebGL Canvas 编码为只存在于浏览器内存中的 JPEG 预览。
 *
 * @param canvas 已完成双鱼眼转换的画布。
 * @param quality JPEG 质量，范围为 0 到 1。
 * @returns 新生成的 Blob；上层负责为它创建和释放 object URL。
 * @throws {X5InspError} 浏览器编码失败时抛出 render-failed。
 */
const encodeCanvas = (canvas: HTMLCanvasElement, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new X5InspError('render-failed', 'Browser failed to encode the panorama canvas'));
        }
      },
      'image/jpeg',
      quality,
    );
  });

/**
 * 把左右排列的 X5 INSP 双鱼眼原图转换为临时等距柱状 JPEG。
 * 转换只使用当前访问客户端的 GPU 和内存，不上传结果，也不在 NAS 生成缓存。
 *
 * @param source 从 Immich 原文件接口读取的完整 INSP Blob。
 * @param options 输出宽度偏好与 JPEG 质量；宽度仍会受源图和 GPU 限制约束。
 * @returns 仅供当前 Viewer 使用的等距柱状 JPEG Blob。
 * @throws {X5InspError} 格式、浏览器能力、解码或 WebGL 任一阶段失败时抛出，调用方应降级。
 */
export const renderX5InspPanorama = async (source: Blob, options: X5InspRenderOptions): Promise<Blob> => {
  await assertJpegContainer(source);
  const image = await decodeInsp(source);
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: true,
    stencil: false,
  });
  if (!gl) {
    image.close();
    throw new X5InspError('unsupported-browser', 'WebGL2 is unavailable');
  }

  let vertexShader: WebGLShader | undefined;
  let fragmentShader: WebGLShader | undefined;
  let program: WebGLProgram | undefined;
  let texture: WebGLTexture | undefined;
  try {
    const gpuLimit = Math.min(
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    );
    const dimensions: PanoramaDimensions = selectPanoramaDimensions(
      image.width,
      image.height,
      gpuLimit,
      options.preferredWidth,
    );
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    gl.viewport(0, 0, dimensions.width, dimensions.height);

    vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = linkProgram(gl, vertexShader, fragmentShader);
    texture = gl.createTexture() ?? undefined;
    if (!texture) {
      throw new X5InspError('render-failed', 'Unable to allocate the INSP source texture');
    }

    const textureSource = fitSourceToTexture(image, gpuLimit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, textureSource);

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'sourceImage'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();

    return await encodeCanvas(canvas, options.jpegQuality ?? 0.92);
  } catch (error) {
    if (error instanceof X5InspError) {
      throw error;
    }
    throw new X5InspError('render-failed', 'Unexpected WebGL failure while rendering INSP', { cause: error });
  } finally {
    if (texture) {
      gl.deleteTexture(texture);
    }
    if (program) {
      gl.deleteProgram(program);
    }
    if (vertexShader) {
      gl.deleteShader(vertexShader);
    }
    if (fragmentShader) {
      gl.deleteShader(fragmentShader);
    }
    image.close();
  }
};
