import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type LibraryDirectoryChanges,
  getLibraryDirectoryWatchRoots,
  watchLibraryDirectories,
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

/** 队列暂时不可用时保留路径并自动重试，不等待任何全库扫描兜底。 */
it('retries rejected submissions without losing their changed paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'immich-watch-retry-'));
  const errors: unknown[] = [];
  const submit = vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue(undefined);
  const watcher = await watchLibraryDirectories(
    root,
    [],
    submit,
    (error) => {
      errors.push(error);
    },
    20,
    { retryMs: 50 },
  );
  try {
    const file = path.join(root, 'new.jpg');
    await writeFile(file, 'synthetic');
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[0][0].paths).toEqual([file]);
    expect(submit.mock.calls[1][0].paths).toEqual([file]);
    expect(errors).toHaveLength(1);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** 安静期内停止进程仍保留事件；重启只重放这些路径，不提交监听根目录。 */
it('replays persisted events after restart without submitting a full root scan', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'immich-watch-replay-'));
  const root = path.join(temporary, 'photos');
  const journalPath = path.join(temporary, 'state', 'pending.json');
  await mkdir(root);
  const errors: unknown[] = [];
  const options = { journalPath, manualScanOnly: true };
  let watcher = await watchLibraryDirectories(
    root,
    [],
    () => Promise.resolve(),
    (error) => {
      errors.push(error);
    },
    1000,
    options,
  );
  const file = path.join(root, 'pending.jpg');
  try {
    await writeFile(file, 'synthetic');
    await vi.waitFor(async () => expect(await readFile(journalPath, 'utf8')).toContain(file));
    watcher.close();
    const submit = vi.fn().mockResolvedValue(undefined);
    watcher = await watchLibraryDirectories(
      root,
      [],
      submit,
      (error) => {
        errors.push(error);
      },
      20,
      options,
    );
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toEqual({ paths: [file], directories: [] });
    await vi.waitFor(async () => expect(JSON.parse(await readFile(journalPath, 'utf8'))).toEqual([]));
    expect(errors).toEqual([]);
  } finally {
    watcher.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

/** 队列提交尚未完成时发生的新写入必须留下第二次检查，不能被旧批次确认覆盖。 */
it('preserves a newer event arriving during an outstanding submission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'immich-watch-race-'));
  const completion = Promise.withResolvers<void>();
  const submit = vi
    .fn()
    .mockImplementationOnce(() => completion.promise)
    .mockResolvedValue(undefined);
  const watcher = await watchLibraryDirectories(root, [], submit, () => {}, 20);
  try {
    const file = path.join(root, 'changed.jpg');
    await writeFile(file, 'before');
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await writeFile(file, 'after');
    await new Promise((resolve) => setTimeout(resolve, 50));
    completion.resolve();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0].paths).toEqual([file]);
  } finally {
    completion.resolve();
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** 根目录被替换后重新注册监听，不能继续守着旧 inode，也不能触发全库资产核对。 */
it('recovers watching after the root directory is replaced', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'immich-watch-root-'));
  const root = path.join(temporary, 'photos');
  await mkdir(root);
  const submit = vi.fn().mockResolvedValue(undefined);
  const watcher = await watchLibraryDirectories(root, [], submit, () => {}, 20, { manualScanOnly: true });
  try {
    await rename(root, path.join(temporary, 'old'));
    await mkdir(root);
    // 新根目录注册完成后，真正的文件事件应继续可见。
    await new Promise((resolve) => setTimeout(resolve, 100));
    const file = path.join(root, 'new.jpg');
    await writeFile(file, 'synthetic');
    await vi.waitFor(() => expect(submit.mock.calls.some(([change]) => change.paths.includes(file))).toBe(true));
    expect(submit.mock.calls.every(([change]) => !change.directories.includes(root))).toBe(true);
  } finally {
    watcher.close();
    await rm(temporary, { recursive: true, force: true });
  }
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
