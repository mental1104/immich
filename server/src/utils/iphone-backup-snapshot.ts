import { createHash } from 'node:crypto';
import { BigIntStats, constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectIphoneBackupHeif, isIphoneBackupHeif } from 'src/utils/iphone-backup-heif.js';

/** 当前无损恢复仅支持最大 64 MiB 的 JPEG/PNG/静态 HEIC，保留文件采用同一上限。 */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SOURCE_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const CHECKSUM = /^[\da-f]{40}$/;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 私有保留文件的完整校验证据；signature 只描述该文件，不代替实际内容摘要。 */
export interface IphoneBackupSnapshot {
  path: string;
  checksum: string;
  signature: string;
  bytes: number;
}

/** 创建保留文件所需的可信原片标识、完整摘要及显式配置的私有根目录。 */
export interface CreateIphoneBackupSnapshotOptions {
  sourcePath: string;
  sourceId: string;
  checksum: string;
  root: string;
}

/** 下载仅依赖已保留文件，不再要求可变的 NAS 原片仍然存在或保持原内容。 */
export interface ReadIphoneBackupSnapshotOptions {
  path: string;
  checksum: string;
  root: string;
}

/** 一次有界、完整、稳定读取的字节及文件状态。 */
interface SnapshotRead {
  content: Buffer;
  stats: BigIntStats;
}

/** @param error 文件系统错误。@param code 预期错误码。@returns 是否匹配该系统错误。 */
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** @param stats 纳秒精度文件状态。@returns 可检测替换、增长和原地改写的稳定签名。 */
function signature(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

/** @param content 实际完整字节。@returns 从文件头识别的格式，不信任上传名称或 NAS 扩展名。 */
function extension(content: Buffer): 'jpg' | 'png' | 'heic' {
  if (content.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) return 'png';
  if (content.length >= 4 && content.readUInt16BE(0) === 0xff_d8) return 'jpg';
  if (isIphoneBackupHeif(content)) {
    // 格式头只负责分派；未知品牌、轨道、外部引用和损坏结构必须通过严格解析器拒绝。
    inspectIphoneBackupHeif(content);
    return 'heic';
  }
  throw new Error('Unsupported backup snapshot image');
}

/** @param path 必须已规范化的绝对路径。@returns 实际目录状态；路径任何层级的符号链接均拒绝。 */
async function privateDirectory(path: string): Promise<BigIntStats> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path) {
    throw new Error('Unsafe backup snapshot directory');
  }
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || (stats.mode & 0o077n) !== 0n) {
    throw new Error('Backup snapshot directory must be private');
  }
  return stats;
}

/** @param path 当前源路径。@param expected 打开前记录的状态。@returns 源仍对应同一个稳定普通文件。 */
async function assertStablePath(path: string, expected: BigIntStats): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (!current.isFile() || signature(current) !== signature(expected) || (await realpath(path)) !== path) {
    throw new Error('Backup snapshot source changed');
  }
}

/**
 * 不跟随最终符号链接，按固定块读取，并复核路径与打开文件的纳秒状态。
 * @param path 已验证目录中的普通文件绝对路径。
 * @param checksum 已知完整 SHA-1；不允许只凭名称或先前统计结果信任内容。
 * @returns 最大 64 MiB 的完整字节与最终稳定状态，损坏或变化时拒绝。
 */
async function readStable(path: string, checksum: string): Promise<SnapshotRead> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_SNAPSHOT_BYTES) || (before.mode & 0o777n) !== 0o600n) {
      throw new Error('Unsafe backup snapshot file');
    }
    await assertStablePath(path, before);
    const chunks: Buffer[] = [];
    const hash = createHash('sha1');
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_SNAPSHOT_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SNAPSHOT_BYTES) throw new Error('Oversized backup snapshot file');
      const content = chunk.subarray(0, bytesRead);
      hash.update(content);
      chunks.push(content);
    }
    const after = await handle.stat({ bigint: true });
    await assertStablePath(path, after);
    if (signature(before) !== signature(after) || BigInt(total) !== after.size || hash.digest('hex') !== checksum) {
      throw new Error('Backup snapshot checksum or stability mismatch');
    }
    return { content: Buffer.concat(chunks, total), stats: after };
  } finally {
    await handle.close();
  }
}

/** @param directory 私有目标目录。@returns 目录项完成落盘后才允许上层提交数据库证据。 */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 校验保留文件的目录布局和实际字节；源原片可已改名、被编辑或离线。
 * @param options 私有目录内的规范路径及预期完整 SHA-1。
 * @returns 一次稳定读取；不接受目录外文件、符号链接、损坏文件或格式伪装。
 */
async function validatedSnapshot(options: ReadIphoneBackupSnapshotOptions): Promise<SnapshotRead> {
  const { path, checksum, root } = options;
  if (!CHECKSUM.test(checksum) || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error('Invalid backup snapshot identity');
  }
  await privateDirectory(root);
  const parts = relative(root, path).split(sep);
  if (
    parts.length !== 2 ||
    !SOURCE_ID.test(parts[0]) ||
    ![`${checksum}.jpg`, `${checksum}.png`, `${checksum}.heic`].includes(parts[1])
  ) {
    throw new Error('Unsafe backup snapshot path');
  }
  await privateDirectory(dirname(path));
  const result = await readStable(path, checksum);
  if (basename(path) !== `${checksum}.${extension(result.content)}`) {
    throw new Error('Backup snapshot image format mismatch');
  }
  return result;
}

/**
 * 下载时重新验证完整 SHA-1，绝不因可变 NAS 文件已不同而丢失先前上传版本。
 * @param options 已保留私有文件与预期完整摘要。
 * @returns 最大 64 MiB 的稳定原文件字节；任何证据失效均抛错。
 */
export async function readIphoneBackupSnapshot(options: ReadIphoneBackupSnapshotOptions): Promise<Buffer> {
  const result = await validatedSnapshot(options);
  return result.content;
}

/**
 * 先写入私有临时文件，再以无覆盖的原子目录项发布完整保留文件。
 * @param options 稳定源路径、资产 UUID、完整 SHA-1 及已存在且权限为 0700 的私有根目录。
 * @returns 完整校验的独立文件；已有快照独立复核后复用，当前 NAS 源无需仍相同或在线。
 */
export async function createIphoneBackupSnapshot(
  options: CreateIphoneBackupSnapshotOptions,
): Promise<IphoneBackupSnapshot> {
  const { sourcePath, sourceId, checksum, root } = options;
  if (!SOURCE_ID.test(sourceId) || !CHECKSUM.test(checksum)) {
    throw new Error('Invalid backup snapshot identity');
  }
  await privateDirectory(root);
  const directory = join(root, sourceId);
  try {
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(root);
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  await privateDirectory(directory);

  // 已保留的版本是独立证据：不能再用后来被编辑的 NAS 原片否定它。
  for (const suffix of ['jpg', 'png', 'heic']) {
    const path = join(directory, `${checksum}.${suffix}`);
    try {
      const existing = await validatedSnapshot({ path, checksum, root });
      return { path, checksum, signature: signature(existing.stats), bytes: existing.content.length };
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }

  if (
    !isAbsolute(sourcePath) ||
    resolve(sourcePath) !== sourcePath ||
    sourcePath === root ||
    sourcePath.startsWith(`${root}${sep}`) ||
    (await realpath(sourcePath)) !== sourcePath
  ) {
    throw new Error('Unsafe backup snapshot source');
  }
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let temporaryDirectory: string | undefined;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_SNAPSHOT_BYTES)) {
      throw new Error('Unsafe backup snapshot source');
    }
    await assertStablePath(sourcePath, before);
    temporaryDirectory = await mkdtemp(join(directory, '.snapshot-'));
    const temporary = join(temporaryDirectory, 'retained');
    // FICLONE 自动在不支持 COW 的文件系统退回完整复制；不使用指向 NAS 原片的硬链接。
    await copyFile(sourcePath, temporary, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    const copied = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      await copied.chmod(0o600);
      await copied.sync();
    } finally {
      await copied.close();
    }
    const retained = await readStable(temporary, checksum);
    if (retained.stats.dev === before.dev && retained.stats.ino === before.ino) {
      throw new Error('Backup snapshot cannot share the source inode');
    }
    if (signature(await source.stat({ bigint: true })) !== signature(before)) {
      throw new Error('Backup snapshot source changed');
    }
    await assertStablePath(sourcePath, before);
    await privateDirectory(root);
    await privateDirectory(directory);
    const path = join(directory, `${checksum}.${extension(retained.content)}`);
    try {
      // 这里只链接本函数拥有的临时副本；已有最终文件永不覆盖，NAS 原片从不参与硬链接。
      await link(temporary, path);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    await unlink(temporary);
    await syncDirectory(directory);
    const published = await validatedSnapshot({ path, checksum, root });
    await assertStablePath(sourcePath, before);
    return { path, checksum, signature: signature(published.stats), bytes: published.content.length };
  } finally {
    await source.close();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
