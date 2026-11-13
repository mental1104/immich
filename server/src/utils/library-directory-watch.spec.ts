import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watchLibraryDirectories, type LibraryDirectoryChanges } from 'src/utils/library-directory-watch.js';

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
