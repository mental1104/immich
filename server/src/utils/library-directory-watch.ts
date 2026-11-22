import { type FSWatcher, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import z from 'zod';
import { isWithinDirectory } from 'src/utils/iphone-backup.js';
import { mimeTypes } from 'src/utils/mime-types.js';

const QUIET_MS = 5000;

/** 一个监听根目录下待核对的文件和子树，路径均为容器绝对路径。 */
export type LibraryDirectoryChanges = { paths: string[]; directories: string[] };

/** 仅持久化已观察到的变化；状态目录应位于 SSD，不能放在受监听的图库中。 */
export type LibraryDirectoryWatchOptions = {
  journalPath?: string;
  retryMs?: number;
  manualScanOnly?: boolean;
};

/** 待提交事件的磁盘边界；路径在恢复时还须重新验证监听范围及排除规则。 */
const pendingSchema = z.array(z.object({ path: z.string(), deadline: z.number(), directory: z.boolean() }));

/**
 * 解析目录监听范围，支持全部导入根、显式 JSON 路径列表和旧版单根配置。
 * @param setting 新配置；all 使用当前导入根，未设置时回退到 legacy。
 * @param legacy 旧版单根目录，继续保持兼容。
 * @param importPaths 当前所有外部图库的导入根；不访问或修改文件系统。
 * @returns 已规范化、去重且不相互嵌套的绝对根目录；非法配置抛错。
 */
export function getLibraryDirectoryWatchRoots(
  setting: string | undefined,
  legacy: string | undefined,
  importPaths: readonly string[],
): string[] {
  const roots: unknown = setting === 'all' ? importPaths : setting ? JSON.parse(setting) : legacy ? [legacy] : [];
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('Library directory watch roots must be absolute paths');
  }
  const normalized = [...new Set((roots as string[]).map((root) => path.resolve(root)))];
  // 父根已经覆盖子根时只注册一次，防止重复事件和重复扫描。
  return normalized.filter((root) => normalized.every((parent) => parent === root || !isWithinDirectory(parent, root)));
}

/**
判断指定文件是否确实消失。权限、I/O 和监听资源错误保留原异常。
@param error 文件系统操作抛出的值。
@returns 只有路径或中间目录不存在时返回 true。
*/
export function isMissingLibraryPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/**
建立单个库根目录的非递归监听树。Linux 在目录 inode 上报告其直接子项变化。
@param root 已校验的绝对根目录。
@param exclusions 库排除规则。跳过隐藏路径、被排除的目录和符号链接。
@param submit 批量提交回调。失败时保留事件，退避后重新提交；调用者必须允许重复投递。
@param onError 报告注册、读取和提交错误。
@param quietMs 同一路径的写入安静期，单位毫秒。
@param options 可选 SSD 日志、提交重试间隔和禁止根目录自动核对的手动扫描策略。
@returns 初始化后的监听对象，调用 close 释放所有 watcher 和定时器。
*/
export async function watchLibraryDirectories(
  root: string,
  exclusions: string[],
  submit: (changes: LibraryDirectoryChanges) => Promise<void>,
  onError: (error: unknown) => void,
  quietMs = QUIET_MS,
  options: LibraryDirectoryWatchOptions = {},
): Promise<{ close: () => void; count: number }> {
  const excluded = picomatch(exclusions, { nocase: true, dot: true });
  const watchers = new Map<string, FSWatcher>();
  let parentWatcher: FSWatcher | undefined;
  const pending = new Map<string, { deadline: number; directory: boolean }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let flushing = false;
  const retryMs = options.retryMs ?? 5000;
  let journalReady = !options.journalPath;

  /** 保存尚未获队列确认的事件；原子替换避免进程中断产生半份状态。失败保留内存并报告。 */
  const persist = () => {
    if (!options.journalPath || !journalReady) {
      return;
    }
    try {
      const temporary = `${options.journalPath}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify([...pending].map(([candidate, entry]) => ({ path: candidate, ...entry }))),
        {
          mode: 0o600,
          flush: true,
        },
      );
      renameSync(temporary, options.journalPath);
    } catch (error) {
      onError(error);
    }
  };

  /** @param directory 已移出、重命名或失效的目录。关闭该目录及后代 inode 的监听。 */
  const unwatch = (directory: string) => {
    for (const [candidate, watcher] of watchers) {
      if (!isWithinDirectory(directory, candidate)) {
        continue;
      }
      watcher.close();
      watchers.delete(candidate);
    }
  };

  /** 按最早的截止时间安排一次提交；正在提交时由它负责安排下一轮。 */
  const schedule = () => {
    if (closed || flushing || pending.size === 0) {
      return;
    }
    clearTimeout(timer);
    let deadline = Infinity;
    for (const entry of pending.values()) {
      deadline = Math.min(deadline, entry.deadline);
    }
    timer = setTimeout(() => void flush().catch(onError), Math.max(0, deadline - Date.now()));
  };

  /**
  重复事件将该路径移到队尾，并保留目录信息以便移出时复查后代资产。
  @param candidate 需要重新核对的绝对路径。
  @param directory 路径在本次事件前是已知目录，或者事件未提供子项名称。
  */
  const mark = (candidate: string, directory: boolean) => {
    if (closed || !isWithinDirectory(root, candidate) || (options.manualScanOnly && candidate === root)) {
      return;
    }
    if (
      candidate !== root &&
      (path.basename(candidate).startsWith('.') || excluded(candidate) || excluded(candidate + '/'))
    ) {
      return;
    }
    const wasDirectory = directory || pending.get(candidate)?.directory === true;
    pending.delete(candidate);
    pending.set(candidate, { deadline: Date.now() + quietMs, directory: wasDirectory });
    persist();
    schedule();
  };

  /**
  先注册监听再枚举子目录，以便收到枚举期间发生的变更。
  @param directory 待注册目录，调用者已检查它在根目录内。
  */
  const register = async (directory: string): Promise<void> => {
    if (closed || watchers.has(directory)) {
      return;
    }
    const stats = await lstat(directory);
    if (!stats.isDirectory() || (await realpath(directory)) !== directory) {
      throw new Error('Library directory watch found a non-canonical directory');
    }
    if (closed || watchers.has(directory)) {
      return;
    }
    const watcher = watch(directory, (event, name) => {
      if (!name && options.manualScanOnly) {
        // 不知道具体变化路径时只报告缺口，不能把丢事件隐式升级成整库扫描。
        onError(new Error('Library watch event has no filename; manual reconciliation is required'));
        return;
      }
      const candidate = name ? path.join(directory, name) : directory;
      const knownDirectory = watchers.has(candidate);
      // rename 可能替换整个 inode，即使路径随后重新出现也需要重新注册。
      if (name && event === 'rename' && knownDirectory) {
        unwatch(candidate);
      }
      mark(candidate, !name || knownDirectory);
    });
    watchers.set(directory, watcher);
    watcher.on('error', (error) => {
      unwatch(directory);
      onError(error);
      // 父目录仍可观察子项；记录一次局部核对，重新注册可用的目录。
      mark(directory, true);
    });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded(child) && !excluded(child + '/')) {
        try {
          await register(child);
        } catch (error) {
          unwatch(child);
          if (!isMissingLibraryPath(error)) {
            throw error;
          }
        }
      }
    }
  };

  /** 核对到期事件。目录移入后先注册其子树，随后让队列核对落盘内容。 */
  const flush = async () => {
    flushing = true;
    const changes: LibraryDirectoryChanges = { paths: [], directories: [] };
    const acknowledged = new Map<string, { deadline: number; directory: boolean }>();
    try {
      const now = Date.now();
      const due = [...pending].filter(([, entry]) => entry.deadline <= now).slice(0, 128);
      for (const [candidate, entry] of due) {
        // 同批前面的异步 I/O 期间，更新的事件可能已经延长了安静期。
        if (closed || pending.get(candidate) !== entry) {
          continue;
        }
        try {
          const stats = await lstat(candidate);
          if (stats.isDirectory() && !excluded(candidate + '/')) {
            // 根目录重新创建时没有父 watcher，由下一次显式重启恢复。已知子目录由父目录事件重建。
            await register(candidate);
            changes.directories.push(candidate);
          } else if (stats.isFile() && mimeTypes.isAsset(candidate)) {
            changes.paths.push(candidate);
          }
          acknowledged.set(candidate, entry);
        } catch (error) {
          if (!isMissingLibraryPath(error)) {
            onError(error);
            // 权限或临时 I/O 错误不能吞事件；等退避后再读取。
            if (pending.get(candidate) === entry) {
              pending.set(candidate, { ...entry, deadline: Date.now() + retryMs });
            }
          } else if (entry.directory) {
            unwatch(candidate);
            changes.directories.push(candidate);
            acknowledged.set(candidate, entry);
          } else if (mimeTypes.isAsset(candidate)) {
            changes.paths.push(candidate);
            acknowledged.set(candidate, entry);
          } else {
            acknowledged.set(candidate, entry);
          }
        }
      }
      if (!closed && (changes.paths.length > 0 || changes.directories.length > 0)) {
        await submit(changes);
      }
      // 提交期间可能又收到同一路径的新事件；仅确认本批捕获的那个版本。
      if (!closed) {
        for (const [candidate, entry] of acknowledged) {
          if (pending.get(candidate) === entry) {
            pending.delete(candidate);
          }
        }
      }
    } catch (error) {
      onError(error);
      for (const [candidate, entry] of acknowledged) {
        if (pending.get(candidate) === entry) {
          pending.set(candidate, { ...entry, deadline: Date.now() + retryMs });
        }
      }
    } finally {
      persist();
      flushing = false;
      schedule();
    }
  };

  /** 停止接收事件并保留未确认事件的 SSD 日志，供下次启动重放。 */
  const close = () => {
    closed = true;
    clearTimeout(timer);
    parentWatcher?.close();
    persist();
    unwatch(root);
  };

  try {
    if (options.journalPath) {
      mkdirSync(path.dirname(options.journalPath), { recursive: true });
      try {
        for (const entry of pendingSchema.parse(JSON.parse(readFileSync(options.journalPath, 'utf8')))) {
          const relative = path.relative(root, entry.path);
          if (
            isWithinDirectory(root, entry.path) &&
            entry.path !== root &&
            relative.split(path.sep).every((part) => !part.startsWith('.')) &&
            !excluded(entry.path) &&
            !excluded(entry.path + '/')
          ) {
            pending.set(entry.path, { directory: entry.directory, deadline: Date.now() + quietMs });
          }
        }
      } catch (error) {
        if (!isMissingLibraryPath(error)) {
          throw error;
        }
      }
      journalReady = true;
    }
    await register(root);
    if (path.dirname(root) !== root) {
      // 父目录监听负责发现根目录的替换和重新创建，避免继续监听已经失效的旧 inode。
      parentWatcher = watch(path.dirname(root), (event, name) => {
        if (!(!closed && event === 'rename' && name === path.basename(root))) {
          return;
        }

        unwatch(root);
        onError(new Error('Library watch root was replaced; manual reconciliation may be required'));
        void register(root).catch((error) => {
          if (!isMissingLibraryPath(error)) {
            onError(error);
          }
        });
      });
      parentWatcher.on('error', onError);
    }
    // 根 watcher 出错或根 inode 被替换后，定期只重建目录监听，不扫描资产。
    const recovery = setInterval(
      () => {
        if (!closed && !watchers.has(root)) {
          void register(root).catch(onError);
        }
      },
      Math.max(retryMs, 1000),
    );
    recovery.unref();
    const release = close;
    schedule();
    return {
      count: watchers.size,
      /** 停止恢复定时器，然后释放目录监听与事件日志。 */
      close: () => {
        clearInterval(recovery);
        release();
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
