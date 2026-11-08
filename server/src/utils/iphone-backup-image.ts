import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import {
  UnsupportedIphoneBackupHeifError,
  inspectIphoneBackupHeif,
  isIphoneBackupHeif,
} from 'src/utils/iphone-backup-heif.js';

/** 一次稳定读取的原片证据；整文件 SHA-1、编码图像及有效元数据分别承担不同职责。 */
export interface IphoneBackupImage {
  checksum: string;
  image: string;
  metadata: string;
  size: number;
  signature: string;
}

/** 文件扩展名不能证明编码类型；有效但未支持的格式保留完整文件，不当成可恢复的 JPEG/PNG。 */
export class UnsupportedIphoneBackupImageError extends Error {
  /** @param cause 底层格式拒绝原因；固定错误文本仍区分未支持格式与真实读取、校验错误。 */
  constructor(cause?: unknown) {
    super('Unsupported backup reference image', { cause });
    this.name = 'UnsupportedIphoneBackupImageError';
  }
}

/** @param bytes 只读字节。@param algorithm 指定摘要算法。@returns 十六进制摘要。 */
function digest(bytes: Buffer | string, algorithm = 'sha256'): string {
  return createHash(algorithm).update(bytes).digest('hex');
}

/** PNG 固定文件头；格式判断不依赖可能被重命名的扩展名。 */
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** @param bytes 实际文件字节。@returns 是否具有完整 PNG 文件头，不读取或修改其他文件。 */
function isPng(bytes: Buffer): boolean {
  return bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER);
}

/** 元数据字节单独保留，图像编码字节按顺序取自同一个物理原片；只接受本版本恢复格式。 */
const recoveryFields = {
  checksum: z.string().regex(/^[a-f\d]{40}$/),
  core: z.string().regex(/^[a-f\d]{64}$/),
  pieces: z.array(z.union([z.object({ bytes: z.number().int().positive() }), z.object({ literal: z.string() })])),
};
const recoverySchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...recoveryFields }),
  z.object({ version: z.literal(2), format: z.literal('HEIC'), ...recoveryFields }),
]);

/** @param bytes 已有有界完整字节。@returns 严格 HEIC 证据，未覆盖的结构转为统一的不支持错误。 */
function heifEvidence(bytes: Buffer) {
  try {
    return inspectIphoneBackupHeif(bytes);
  } catch (error) {
    if (error instanceof UnsupportedIphoneBackupHeifError) throw new UnsupportedIphoneBackupImageError(error);
    throw error;
  }
}

/** @param bytes 已有有界完整原片。@returns 不重编码的分段、本体和结构证明；HEIC 配置也必须一致。 */
function recoveryEvidence(bytes: Buffer) {
  const heif = isIphoneBackupHeif(bytes) ? heifEvidence(bytes) : undefined;
  const pieces = heif?.pieces ?? recoveryPieces(bytes);
  const core = Buffer.concat(pieces.filter((piece) => !piece.metadata).map((piece) => piece.bytes));
  return { pieces, core, fingerprint: heif?.fingerprint ?? digest(core), heif: !!heif };
}

/** @param bytes 已验证格式的原片。@returns 恢复文件扩展名，避免 HEIC 原片被交给 JPEG 解码路径。 */
export function iphoneBackupImageExtension(bytes: Buffer): 'png' | 'jpg' | 'heic' {
  return isPng(bytes) ? 'png' : isIphoneBackupHeif(bytes) ? 'heic' : 'jpg';
}

/**
 * 切分 PNG 的 EXIF/文本块，其余块及 CRC 全部保留为共同编码数据。
 * @param bytes 已确认固定文件头的完整 PNG，最大 64 MiB。
 * @returns 包含完整块边界的顺序片段；颜色、动画或未知块差异仍阻止共用，不猜测其语义。
 */
function pngRecoveryPieces(bytes: Buffer): { bytes: Buffer; metadata: boolean }[] {
  const pieces = [{ bytes: bytes.subarray(0, PNG_HEADER.length), metadata: false }];
  let offset = PNG_HEADER.length;
  while (offset < bytes.length) {
    if (pieces.length > 4096 || offset + 12 > bytes.length) throw new Error('Invalid backup PNG chunk');
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Truncated backup PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || (offset === PNG_HEADER.length && (type !== 'IHDR' || length !== 13)))
      throw new Error('Invalid backup PNG structure');
    pieces.push({ bytes: bytes.subarray(offset, end), metadata: ['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(type) });
    offset = end;
    if (type === 'IEND') {
      if (length !== 0) throw new Error('Invalid backup PNG end');
      // 尾部仍属于需要逐字节相同的内容，不能以解码器忽略尾部为由丢弃原文件字节。
      if (offset < bytes.length) pieces.push({ bytes: bytes.subarray(offset), metadata: false });
      return pieces;
    }
  }
  throw new Error('Missing backup PNG end');
}

/**
 * 切分 JPEG/PNG 元数据与其余完整字节；JPEG 扫描开始后的内容全部保留，避免误识别压缩数据。
 * @param bytes 最大 64 MiB 的完整 JPEG 或 PNG。
 * @returns 顺序分段；元数据段单独标记。不支持的格式或非法块边界直接拒绝。
 */
function recoveryPieces(bytes: Buffer): { bytes: Buffer; metadata: boolean }[] {
  if (isPng(bytes)) return pngRecoveryPieces(bytes);
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xff_d8) throw new Error('Invalid recovery JPEG');
  const pieces = [{ bytes: bytes.subarray(0, 2), metadata: false }];
  let offset = 2;
  while (offset < bytes.length) {
    if (pieces.length > 4096) throw new Error('Backup JPEG has too many segments');
    const start = offset;
    if (bytes[offset++] !== 0xff) throw new Error('Invalid recovery marker');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) {
      pieces.push({ bytes: bytes.subarray(start), metadata: false });
      return pieces;
    }
    if (offset + 2 > bytes.length) throw new Error('Truncated recovery JPEG');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error('Invalid recovery segment');
    offset += length;
    pieces.push({
      bytes: bytes.subarray(start, offset),
      metadata: (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe,
    });
  }
  throw new Error('Missing recovery scan');
}

/**
 * 建立无损元数据配方：只存手机版本的 APP/COM 或 PNG EXIF/文本块，编码图像仍只保留 NAS 的一份。
 * @param phone 完整手机版本 JPEG/PNG。
 * @param source 完整 NAS JPEG/PNG，非元数据字节必须与手机版本逐字节相同。
 * @returns gzip 配方；格式、编码数据或大小不符合约束时抛错。
 */
export function createIphoneBackupRecovery(phone: Buffer, source: Buffer): Buffer {
  if (phone.length > 64 * 1024 * 1024 || source.length > 64 * 1024 * 1024)
    throw new Error('Oversized backup recovery input');
  const fresh = recoveryEvidence(phone);
  const existing = recoveryEvidence(source);
  if (fresh.heif !== existing.heif || fresh.fingerprint !== existing.fingerprint || !fresh.core.equals(existing.core))
    throw new Error('Recovery image data differs');
  const recipe = {
    version: fresh.heif ? 2 : 1,
    ...(fresh.heif && { format: 'HEIC' }),
    checksum: digest(phone, 'sha1'),
    core: fresh.fingerprint,
    pieces: fresh.pieces.map((piece) =>
      piece.metadata ? { literal: piece.bytes.toString('base64') } : { bytes: piece.bytes.length },
    ),
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(recipe)));
  if (compressed.length > 1024 * 1024) throw new Error('Backup metadata recovery exceeds size limit');
  return compressed;
}

/**
 * 使用 NAS 编码图像和已保存的元数据恢复原始手机版本，最后复核完整 SHA-1。
 * @param source 当前只读 NAS JPEG/PNG；元数据可变，编码数据必须仍相同。
 * @param compressed 已保存的 gzip 配方，最大 1 MiB。
 * @returns 与上传版本逐字节一致的新缓冲区；源变化、损坏或超限时拒绝恢复。
 */
export function restoreIphoneBackupImage(source: Buffer, compressed: Buffer): Buffer {
  if (compressed.length > 1024 * 1024 || source.length > 64 * 1024 * 1024)
    throw new Error('Oversized backup recovery input');
  const recipe = recoverySchema.parse(
    JSON.parse(gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8')),
  );
  const evidence = recoveryEvidence(source);
  const core = evidence.core;
  if ((recipe.version === 2) !== evidence.heif || evidence.fingerprint !== recipe.core)
    throw new Error('Backup recovery source image changed');
  let offset = 0;
  let total = 0;
  const output: Buffer[] = [];
  for (const piece of recipe.pieces) {
    let bytes: Buffer;
    if ('bytes' in piece) {
      if (offset + piece.bytes > core.length) throw new Error('Invalid backup recovery range');
      bytes = core.subarray(offset, offset + piece.bytes);
      offset += piece.bytes;
    } else {
      bytes = Buffer.from(piece.literal, 'base64');
    }
    total += bytes.length;
    if (total > 64 * 1024 * 1024) throw new Error('Oversized restored backup');
    output.push(bytes);
  }
  const restored = Buffer.concat(output);
  if (offset !== core.length || digest(restored, 'sha1') !== recipe.checksum)
    throw new Error('Restored backup checksum mismatch');
  return restored;
}

/**
 * 为原片下载创建请求专属临时文件，保证返回原始手机版本及正常的 Range/长度语义。
 * @param sourcePath 经过鉴权且仍在线的 NAS 原片路径。
 * @param recovery 版本恢复配方；普通资产不调用此方法。
 * @returns 对应格式的临时原片路径和传输完成后的清理回调；恢复失败时自行回收临时目录。
 */
export async function materializeIphoneBackupImage(
  sourcePath: string,
  recovery: Buffer,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'immich-backup-download-'));
  /** 只删除本请求创建的临时目录，不触碰 NAS 原片或其他请求文件。 */
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const source = await lstat(sourcePath);
    if (!source.isFile() || source.size > 64 * 1024 * 1024 || (await realpath(sourcePath)) !== sourcePath)
      throw new Error('Unsafe backup download source');
    const bytes = await readFile(sourcePath);
    const filename = join(directory, `original.${iphoneBackupImageExtension(bytes)}`);
    await writeFile(filename, restoreIphoneBackupImage(bytes, recovery), {
      flag: 'wx',
      mode: 0o600,
    });
    return { path: filename, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * 保留 JPEG 编码参数、扫描数据和尾部内容，独立保护 ExifTool 图像摘要未覆盖的编码结构。
 * @param bytes 完整 JPEG，只读取 APP/COM 段边界，不重新编码。
 * @returns 编码字节及 ICC/Adobe 显示配置摘要；非法或超界标记抛错。
 */
function jpegChecksum(bytes: Buffer): string {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xff_d8) {
    throw new Error('Unsupported backup reference image');
  }
  const core = createHash('sha256').update(bytes.subarray(0, 2));
  const rendering = createHash('sha256');
  let offset = 2;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) {
      throw new Error('Invalid JPEG marker');
    }
    while (bytes[offset] === 0xff) {
      offset++;
    }
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) {
      core.update(bytes.subarray(start));
      return `${core.digest('hex')}:${rendering.digest('hex')}`;
    }
    if (offset + 2 > bytes.length) {
      throw new Error('Truncated JPEG marker');
    }
    const length = bytes.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) {
      throw new Error('Invalid JPEG segment length');
    }
    const payload = bytes.subarray(offset + 2, end);
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      // ICC 与 Adobe 颜色解释必须相同，不能因为都属于 APP 段便直接忽略。
      if (payload.subarray(0, 12).toString('ascii').startsWith('ICC_PROFILE') || marker === 0xee) {
        rendering.update(bytes.subarray(start, end));
      }
    } else {
      core.update(bytes.subarray(start, end));
    }
    offset = end;
  }
  throw new Error('Missing JPEG scan');
}

/**
 * 规范化对象键；数组顺序保持不变，避免把有效设置的顺序变化悄悄忽略。
 * @param value ExifTool 返回的 JSON 值。
 * @returns 可稳定 JSON 序列化的新值，不修改输入。
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/**
 * 仅忽略已经证实的 shared 标签、写入工具和结构偏移；其他可解析字段全部参与校验。
 * @param tags 严格读取的分组标签，不修改原对象。
 * @returns 用于同一版本读前后校验的元数据摘要；它不要求 NAS 与手机版本的元数据相同。
 */
export function iphoneBackupMetadataChecksum(tags: Record<string, unknown>): string {
  const fields: Record<string, unknown> = {};
  for (const [key, original] of Object.entries(tags)) {
    if (
      ['SourceFile', 'errors', 'warnings', 'IPTC:CodedCharacterSet', 'XMP:XMP-x:XMPToolkit'].includes(key) ||
      /^(File|System|Composite|ExifTool)(:|$)/.test(key) ||
      /^MPF:.*:MPImageStart$/.test(key)
    ) {
      continue;
    }
    if (key === 'IPTC:Keywords' || key === 'XMP:XMP-dc:Subject') {
      const values = (Array.isArray(original) ? original : [original]).filter((value) => value !== 'shared');
      if (values.length > 0) {
        fields[key] = values;
      }
      continue;
    }
    fields[key] = original;
  }
  return digest(JSON.stringify(canonical(fields)));
}

/**
 * 对小型 JPEG/PNG 取得稳定的实际文件证据；任何警告、符号链接或读取期间变化均停止处理。
 * @param filename 已校验归属的绝对路径，最大 64 MiB。
 * @param metadata 严格只读的 ExifTool 访问器。
 * @returns 整文件及图像、元数据摘要；不创建派生文件、不更新数据库。
 */
export async function readIphoneBackupImage(
  filename: string,
  metadata: Pick<MetadataRepository, 'readBackupTags'>,
): Promise<IphoneBackupImage> {
  const before = await lstat(filename, { bigint: true });
  if (!before.isFile() || before.size > 64n * 1024n * 1024n || (await realpath(filename)) !== filename) {
    throw new Error('Unsafe backup reference file');
  }
  const bytes = await readFile(filename);
  const tags = await metadata.readBackupTags(filename);
  if ([tags.errors, tags.warnings].some((items) => Array.isArray(items) && items.length > 0)) {
    throw new Error('Backup reference metadata has warnings');
  }
  // 官方手机上传可能保留 JPG 名称但发送 HEIC 内容；按实际格式分类，不能靠扩展名猜测。
  const format = tags['File:FileType'];
  if (typeof format === 'string' && !['JPEG', 'PNG', 'HEIC', 'HEIF'].includes(format)) {
    throw new UnsupportedIphoneBackupImageError();
  }
  const image = tags['File:ImageDataHash'];
  if (typeof image !== 'string' || !/^[a-f\d]{64}$/i.test(image)) {
    throw new Error('Missing backup image checksum');
  }
  const after = await lstat(filename, { bigint: true });
  const signature = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
  if (signature !== `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`) {
    throw new Error('Backup reference file changed during reading');
  }
  const heif = isIphoneBackupHeif(bytes) ? heifEvidence(bytes) : undefined;
  if ((format === 'HEIC' || format === 'HEIF') && !heif) throw new UnsupportedIphoneBackupImageError();
  return {
    checksum: digest(bytes, 'sha1'),
    image: `${image}:${
      heif
        ? heif.fingerprint
        : isPng(bytes)
          ? digest(
              Buffer.concat(
                recoveryPieces(bytes)
                  .filter((piece) => !piece.metadata)
                  .map((piece) => piece.bytes),
              ),
            )
          : jpegChecksum(bytes)
    }`,
    metadata: iphoneBackupMetadataChecksum(tags),
    size: bytes.length,
    signature,
  };
}
