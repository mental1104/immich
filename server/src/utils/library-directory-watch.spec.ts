import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getLibraryDirectoryWatchRoots,
  watchLibraryDirectories,
  type LibraryDirectoryChanges,
} from 'src/utils/library-directory-watch.js';

/** 配置全部导入根时，嵌套根只监听一次，旧版单根仍保持兼容。 */
it('resolves all import roots and preserves the legacy single root', () => {
  expect(getLibraryDirectoryWatchRoots('all', '/old', ['/photos', '/photos/nested', '/other'])).toEqual([
    '/photos',
    '/other',
  ]);
  expect(getLibraryDirectoryWatchRoots(undefined, '/old', ['/photos'])).toEqual(['/old']);
  expect(getLibraryDirectoryWatchRoots('["/photos","/other"]', '/old', [])).toEqual(['/photos', '/other']);
  expect(() => getLibraryDirectoryWatchRoots('["relative"]', undefined, [])).toThrow('absolute paths');
});

/** 新建多层子目录后，叶子目录继续接收后续文件事件，不依赖定时补扫。 */
it('watches newly created nested directories after their initial discovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'immich-nested-watch-'));
  const changes: LibraryDirectoryChanges[] = [];
  const errors: unknown[] = [];
  const watcher = await watchLibraryDirectories(
    root,
    [],
    async (change) => {
      changes.push(change);
    },
    (error) => {
      errors.push(error);
    },
    20,
  );
  try {
    const nested = path.join(root, 'one', 'two');
    await mkdir(nested, { recursive: true });
    await vi.waitFor(() =>
      expect(changes.some((change) => change.directories.includes(path.join(root, 'one')))).toBe(true),
    );
    const file = path.join(nested, 'later.png');
    await writeFile(file, 'synthetic');
    await vi.waitFor(() => expect(changes.some((change) => change.paths.includes(file))).toBe(true));
    expect(errors).toEqual([]);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** 用真实文件系统验证目录监听能够区分普通文件和移入、移出的目录。 */
it('reports changed files and moved subtrees using only directory watchers', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'immich-directory-watch-'));
  const root = path.join(temporary, 'watched');
  const incoming = path.join(temporary, 'incoming');
  const nested = path.join(root, 'nested.jpg');
  const existing = path.join(root, 'existing.jpg');
  await mkdir(path.join(root, 'ignore'), { recursive: true });
  await mkdir(incoming);
  await writeFile(path.join(incoming, 'photo.jpg'), 'synthetic');
  await writeFile(existing, 'before');
  const changes: LibraryDirectoryChanges[] = [];
  const errors: unknown[] = [];
  const watcher = await watchLibraryDirectories(
    root,
    ['**/ignore/**'],
    (change) => {
      changes.push(change);
      return Promise.resolve();
    },
    (error) => {
      errors.push(error);
    },
    30,
  );
  try {
    // 只注册根目录；已有文件和排除子树不占用监听。
    expect(watcher.count).toBe(1);
    await writeFile(existing, 'after');
    await writeFile(path.join(root, 'ignore', 'excluded.jpg'), 'synthetic');
    await vi.waitFor(() => expect(changes.flatMap(({ paths }) => paths)).toEqual([existing]));

    await rename(incoming, nested);
    await vi.waitFor(() => expect(changes.flatMap(({ directories }) => directories)).toEqual([nested]));
    const moved = path.join(nested, 'photo.jpg');
    await unlink(moved);
    await vi.waitFor(() => expect(changes.flatMap(({ paths }) => paths)).toEqual([existing, moved]));

    // 目录即使名称具有媒体扩展名，也应作为子树复查。
    await rename(nested, incoming);
    await vi.waitFor(() => expect(changes.flatMap(({ directories }) => directories)).toEqual([nested, nested]));
    expect(errors).toEqual([]);
  } finally {
    watcher.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
