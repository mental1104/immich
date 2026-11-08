import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createIphoneBackupSnapshot, readIphoneBackupSnapshot } from 'src/utils/iphone-backup-snapshot.js';
import { createSyntheticIphoneHeic } from 'test/fixtures/iphone-heic.fixture.js';

/** 只在指定场景的真实复制完成后注入改写，避免依赖线程调度碰巧触发源变化。 */
const copyFault = vi.hoisted(() => ({ afterCopy: undefined as (() => Promise<void>) | undefined }));

/** 保留真实文件系统行为，仅给源变化场景提供确定性的复制结束边界。 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    /** @param arguments_ 原生复制参数。@returns 完成真实复制并执行当前场景的故障注入。 */
    copyFile: async (...arguments_: Parameters<typeof actual.copyFile>) => {
      await actual.copyFile(...arguments_);
      await copyFault.afterCopy?.();
    },
  };
});

/** 合成图像不包含私人照片；验证保留文件能跨 NAS 原片后续改写独立存活。 */
describe('iPhone backup immutable source snapshot', () => {
  const sourceId = '11111111-2222-4333-8444-555555555555';
  let directory: string;
  let root: string;
  let sourcePath: string;
  let jpeg: Buffer;
  let png: Buffer;

  /** @param content 完整合成文件字节。@returns 与官方原片校验兼容的完整 SHA-1。 */
  function checksum(content: Buffer): string {
    return createHash('sha1').update(content).digest('hex');
  }

  /** @returns 当前测试使用的显式私有根目录、源标识和完整 JPEG 摘要。 */
  function options() {
    return { root, sourceId, sourcePath, checksum: checksum(jpeg) };
  }

  /** 为所有场景生成无隐私且可正常解码的两种格式。 */
  beforeAll(async () => {
    const image = sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } });
    jpeg = await image.clone().jpeg().toBuffer();
    png = await image.clone().png().toBuffer();
  });

  /** 每个场景使用独立目录，禁止接触真实图库或其他测试文件。 */
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'immich-snapshot-test-'));
    root = join(directory, 'private');
    sourcePath = join(directory, 'source.jpg');
    await fs.mkdir(root, { mode: 0o700 });
    await fs.writeFile(sourcePath, jpeg, { mode: 0o600 });
  });

  /** 只回收本场景创建的临时目录，并恢复受控文件系统故障注入。 */
  afterEach(async () => {
    copyFault.afterCopy = undefined;
    await fs.rm(directory, { recursive: true, force: true });
  });

  /** 保留文件有独立 inode、私有权限和完整摘要，NAS 原片状态不受影响。 */
  it('retains a complete independent private file with a verified identity', async () => {
    const original = await fs.stat(sourcePath, { bigint: true });
    const result = await createIphoneBackupSnapshot(options());
    expect(result.path).toBe(join(root, sourceId, `${checksum(jpeg)}.jpg`));
    expect(result.checksum).toBe(checksum(jpeg));
    expect(result.bytes).toBe(jpeg.length);
    const retained = await fs.stat(result.path, { bigint: true });
    expect([retained.dev, retained.ino]).not.toEqual([original.dev, original.ino]);
    expect(retained.mode & 0o777n).toBe(0o600n);
    expect(result.signature).toBe(
      `${retained.dev}:${retained.ino}:${retained.size}:${retained.mtimeNs}:${retained.ctimeNs}`,
    );
    expect(await readIphoneBackupSnapshot({ ...result, root })).toEqual(jpeg);
    expect(await fs.stat(sourcePath, { bigint: true })).toMatchObject({
      ino: original.ino,
      size: original.size,
      mtimeNs: original.mtimeNs,
      ctimeNs: original.ctimeNs,
    });
    expect(await fs.readdir(join(root, sourceId))).toEqual([`${checksum(jpeg)}.jpg`]);
  });

  /** 文件名可被照片管理软件改错，保留扩展名必须来自真实 PNG 文件头。 */
  it('uses actual image magic when a JPG filename contains PNG data', async () => {
    await fs.writeFile(sourcePath, png);
    const result = await createIphoneBackupSnapshot({ ...options(), checksum: checksum(png) });
    expect(result.path.endsWith('.png')).toBe(true);
    expect(await readIphoneBackupSnapshot({ ...result, root })).toEqual(png);
  });

  /** 真正 HEVC 编码的合成 HEIC 按实际格式保留，后续 NAS 改写不能修改已保存版本。 */
  it('retains a real synthetic HEIC independently of source naming and later edits', async () => {
    const original = createSyntheticIphoneHeic('phone');
    await fs.writeFile(sourcePath, original);
    const input = { ...options(), checksum: checksum(original) };
    const result = await createIphoneBackupSnapshot(input);
    expect(result.path).toBe(join(root, sourceId, `${checksum(original)}.heic`));
    const source = await fs.stat(sourcePath, { bigint: true });
    const retained = await fs.stat(result.path, { bigint: true });
    expect([source.dev, source.ino]).not.toEqual([retained.dev, retained.ino]);
    expect(retained.mode & 0o777n).toBe(0o600n);
    await fs.writeFile(sourcePath, createSyntheticIphoneHeic('NAS metadata rewrite'));
    expect(await readIphoneBackupSnapshot({ ...result, root })).toEqual(original);
    await fs.unlink(sourcePath);
    expect(await createIphoneBackupSnapshot(input)).toEqual(result);
  });

  /** HEIF 魔数不能替代完整结构证明；已知品牌但截断的文件不允许发布为快照。 */
  it('rejects malformed HEIC containers without publishing them', async () => {
    const malformed = createSyntheticIphoneHeic().subarray(0, 64);
    await fs.writeFile(sourcePath, malformed);
    await expect(createIphoneBackupSnapshot({ ...options(), checksum: checksum(malformed) })).rejects.toThrow();
    expect(await fs.readdir(join(root, sourceId))).toEqual([]);
  });

  /** 不接受把未知 ISO 格式或者 AVIF 品牌写成 HEIC 扩展名的文件。 */
  it.each(['zzzz', 'avif'])('rejects unknown or unsupported HEIF brand %s', async (brand) => {
    const unsupported = createSyntheticIphoneHeic();
    unsupported.write(brand, 8, 'ascii');
    unsupported.write(brand, 16, 'ascii');
    unsupported.write(brand, 20, 'ascii');
    await fs.writeFile(sourcePath, unsupported);
    await expect(createIphoneBackupSnapshot({ ...options(), checksum: checksum(unsupported) })).rejects.toThrow();
    expect(await fs.readdir(join(root, sourceId))).toEqual([]);
  });

  /** 原地改写和路径替换均不能传播到独立保留文件；旧版本仍可下载和复用。 */
  it('survives source in-place edits, replacement, and disappearance', async () => {
    const result = await createIphoneBackupSnapshot(options());
    const retained = await fs.stat(result.path, { bigint: true });
    await fs.writeFile(sourcePath, png);
    expect(await readIphoneBackupSnapshot({ ...result, root })).toEqual(jpeg);
    expect(await createIphoneBackupSnapshot(options())).toEqual(result);
    const replacement = join(directory, 'replacement');
    await fs.writeFile(replacement, 'replacement source');
    await fs.rename(replacement, sourcePath);
    expect(await createIphoneBackupSnapshot(options())).toEqual(result);
    await fs.unlink(sourcePath);
    expect(await createIphoneBackupSnapshot(options())).toEqual(result);
    expect(await fs.stat(result.path, { bigint: true })).toMatchObject({ ino: retained.ino });
    expect(await readIphoneBackupSnapshot({ ...result, root })).toEqual(jpeg);
  });

  /** 多个首次引用并发发布时只能得到同一个最终文件，不替换其他请求的结果。 */
  it('publishes concurrently without overwriting the first retained file', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => createIphoneBackupSnapshot(options())));
    expect(new Set(results.map((result) => result.path)).size).toBe(1);
    expect(await readIphoneBackupSnapshot({ ...results[0], root })).toEqual(jpeg);
    expect(await fs.readdir(join(root, sourceId))).toEqual([`${checksum(jpeg)}.jpg`]);
    const stats = await fs.stat(results[0].path);
    expect(stats.nlink).toBe(1);
  });

  /** 完整 SHA-1 不符时不得发布任何快照，也不得修改 NAS 原文件。 */
  it('refuses a mismatched checksum and removes incomplete temporary copies', async () => {
    await expect(createIphoneBackupSnapshot({ ...options(), checksum: '0'.repeat(40) })).rejects.toThrow(
      'checksum or stability mismatch',
    );
    expect(await fs.readdir(join(root, sourceId))).toEqual([]);
    expect(await fs.readFile(sourcePath)).toEqual(jpeg);
  });

  /** 已有最终文件损坏时只能拒绝，不能静默覆盖后让旧数据库证据看似仍然成立。 */
  it('revalidates existing files and never repairs corrupt snapshots by overwriting', async () => {
    const result = await createIphoneBackupSnapshot(options());
    await fs.writeFile(result.path, 'corrupt snapshot');
    await expect(readIphoneBackupSnapshot({ ...result, root })).rejects.toThrow('checksum or stability mismatch');
    await expect(createIphoneBackupSnapshot(options())).rejects.toThrow('checksum or stability mismatch');
    expect(await fs.readFile(result.path, 'utf8')).toBe('corrupt snapshot');
  });

  /** 即使哈希吻合，配置指向符号链接目录也不能让私有副本落到意外位置。 */
  it('rejects a symbolic-link root and a symbolic-link source', async () => {
    const alias = join(directory, 'root-alias');
    await fs.symlink(root, alias);
    await expect(createIphoneBackupSnapshot({ ...options(), root: alias })).rejects.toThrow('Unsafe');
    const sourceAlias = join(directory, 'source-alias');
    await fs.symlink(sourcePath, sourceAlias);
    await expect(createIphoneBackupSnapshot({ ...options(), sourcePath: sourceAlias })).rejects.toThrow('Unsafe');
  });

  /** 资产目录和最终文件同样不允许符号链接穿越私有根目录。 */
  it('rejects symbolic-link source directories and final files', async () => {
    const outside = join(directory, 'outside');
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, join(root, sourceId));
    await expect(createIphoneBackupSnapshot(options())).rejects.toThrow('Unsafe');
    await fs.unlink(join(root, sourceId));
    await fs.mkdir(join(root, sourceId), { mode: 0o700 });
    const path = join(root, sourceId, `${checksum(jpeg)}.jpg`);
    await fs.symlink(sourcePath, path);
    await expect(createIphoneBackupSnapshot(options())).rejects.toThrow();
    await expect(readIphoneBackupSnapshot({ path, checksum: checksum(jpeg), root })).rejects.toThrow();
    expect(await fs.readFile(sourcePath)).toEqual(jpeg);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  /** 模式配置错误必须阻止使用，避免原片数据落入可被其他用户读取的目录。 */
  it('rejects non-private directories and non-private existing files', async () => {
    await fs.chmod(root, 0o755);
    await expect(createIphoneBackupSnapshot(options())).rejects.toThrow('directory must be private');
    await fs.chmod(root, 0o700);
    const result = await createIphoneBackupSnapshot(options());
    await fs.chmod(result.path, 0o644);
    await expect(readIphoneBackupSnapshot({ ...result, root })).rejects.toThrow('Unsafe backup snapshot file');
  });

  /** 身份和路径必须严格受根目录约束，不能用校验函数读取任意 NAS 文件。 */
  it('rejects traversal identities and reads outside the configured root', async () => {
    await expect(createIphoneBackupSnapshot({ ...options(), sourceId: '../outside' })).rejects.toThrow('identity');
    await expect(createIphoneBackupSnapshot({ ...options(), checksum: '../checksum' })).rejects.toThrow('identity');
    await expect(readIphoneBackupSnapshot({ path: sourcePath, checksum: checksum(jpeg), root })).rejects.toThrow(
      'Unsafe backup snapshot path',
    );
    const nested = join(root, 'source.jpg');
    await fs.writeFile(nested, jpeg);
    await expect(createIphoneBackupSnapshot({ ...options(), sourcePath: nested })).rejects.toThrow('Unsafe');
  });

  /** 超限普通文件在读取前被拒绝；非图像即使完整摘要吻合也不发布。 */
  it('rejects oversized and unsupported source files', async () => {
    await fs.truncate(sourcePath, 64 * 1024 * 1024 + 1);
    await expect(createIphoneBackupSnapshot(options())).rejects.toThrow('Unsafe backup snapshot source');
    const unsupported = Buffer.from('not an image');
    await fs.writeFile(sourcePath, unsupported);
    await expect(createIphoneBackupSnapshot({ ...options(), checksum: checksum(unsupported) })).rejects.toThrow(
      'Unsupported backup snapshot image',
    );
    expect(await fs.readdir(join(root, sourceId))).toEqual([]);
  });

  /** 复制后发生的源文件改写必须使本次建档失败，不能依赖旧的路径统计结果。 */
  it('refuses a source modified while its copy is being prepared', async () => {
    copyFault.afterCopy = async () => {
      await fs.writeFile(sourcePath, png);
    };
    await expect(createIphoneBackupSnapshot(options())).rejects.toThrow('source changed');
    expect(await fs.readdir(join(root, sourceId))).toEqual([]);
    expect(await fs.readFile(sourcePath)).toEqual(png);
  });
});

/** 仅对显式指定的新建私有测试目录运行真实文件系统 COW 验证，默认测试不接触 NAS 路径。 */
describe.runIf(Boolean(process.env.IMMICH_TEST_SNAPSHOT_ROOT))('iPhone snapshot filesystem integration', () => {
  /** 强制 FICLONE 不允许退回普通复制；只改写刚刚生成的合成源文件。 */
  it('proves filesystem COW support and independent content after source writes', async () => {
    const directory = await fs.mkdtemp(join(process.env.IMMICH_TEST_SNAPSHOT_ROOT!, 'cow-fixture-'));
    try {
      const source = join(directory, 'synthetic-source');
      const clone = join(directory, 'synthetic-clone');
      const original = Buffer.alloc(1024 * 1024, 0x53);
      await fs.writeFile(source, original, { mode: 0o600 });
      await fs.copyFile(source, clone, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
      const sourceStats = await fs.stat(source, { bigint: true });
      const cloneStats = await fs.stat(clone, { bigint: true });
      expect(sourceStats.dev).toBe(cloneStats.dev);
      expect(sourceStats.ino).not.toBe(cloneStats.ino);
      const changed = await fs.open(source, 'r+');
      try {
        await changed.write(Buffer.from('changed synthetic source'), 0, 24, 0);
        await changed.sync();
      } finally {
        await changed.close();
      }
      expect(await fs.readFile(clone)).toEqual(original);
      expect(await fs.readFile(source)).not.toEqual(original);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  /** 跨文件系统无法克隆，仍须自动完成独立完整复制，不能放宽摘要或稳定性检查。 */
  it('falls back to a verified full copy across different filesystems', async () => {
    const directory = await fs.mkdtemp(join(process.env.IMMICH_TEST_SNAPSHOT_ROOT!, 'copy-fixture-'));
    const root = await fs.mkdtemp(join(tmpdir(), 'immich-snapshot-cross-device-'));
    try {
      const sourcePath = join(directory, 'synthetic-source.jpg');
      const content = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#abcdef' } })
        .jpeg()
        .toBuffer();
      const checksum = createHash('sha1').update(content).digest('hex');
      await fs.writeFile(sourcePath, content, { mode: 0o600 });
      const sourceStats = await fs.stat(sourcePath, { bigint: true });
      const rootStats = await fs.stat(root, { bigint: true });
      expect(sourceStats.dev).not.toBe(rootStats.dev);
      const result = await createIphoneBackupSnapshot({
        sourcePath,
        sourceId: '22222222-3333-4444-8555-666666666666',
        checksum,
        root,
      });
      expect(await readIphoneBackupSnapshot({ ...result, root })).toEqual(content);
      await fs.writeFile(sourcePath, 'changed only synthetic source');
      expect(await readIphoneBackupSnapshot({ ...result, root })).toEqual(content);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
