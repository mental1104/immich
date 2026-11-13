import { watch, type FSWatcher } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { isWithinDirectory } from 'src/utils/iphone-backup.js';
import { mimeTypes } from 'src/utils/mime-types.js';

const QUIET_MS = 5000;

/** 一个监听根目录下待核对的文件和子树，路径均为容器绝对路径。 */
export type LibraryDirectoryChanges = { paths: string[]; directories: string[] };

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
@param submit 批量提交回调。提交失败的批次会记录错误，由后续全量校验补齐。
@param onError 报告注册、读取和提交错误。
@param quietMs 同一路径的写入安静期，单位毫秒。
@returns 初始化后的监听对象，调用 close 释放所有 watcher 和定时器。
*/
export async function watchLibraryDirectories(
  root: string,
  exclusions: string[],
  submit: (changes: LibraryDirectoryChanges) => Promise<void>,
  onError: (error: unknown) => void,
  quietMs = QUIET_MS,
): Promise<{ close: () => void; count: number }> {
  const excluded = picomatch(exclusions, { nocase: true, dot: true });
  const watchers = new Map<string, FSWatcher>();
  const pending = new Map<string, { deadline: number; directory: boolean }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let flushing = false;

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
    const next = pending.values().next().value!;
    timer = setTimeout(() => void flush().catch(onError), Math.max(0, next.deadline - Date.now()));
  };

  /**
  重复事件将该路径移到队尾，并保留目录信息以便移出时复查后代资产。
  @param candidate 需要重新核对的绝对路径。
  @param directory 路径在本次事件前是已知目录，或者事件未提供子项名称。
  */
  const mark = (candidate: string, directory: boolean) => {
    if (closed || !isWithinDirectory(root, candidate)) {
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
    try {
      const now = Date.now();
      const due = [...pending].filter(([, entry]) => entry.deadline <= now);
      for (const [candidate, entry] of due) {
        // 同批前面的异步 I/O 期间，更新的事件可能已经延长了安静期。
        if (closed || pending.get(candidate) !== entry) {
          continue;
        }
        pending.delete(candidate);
        try {
          const stats = await lstat(candidate);
          if (stats.isDirectory() && !excluded(candidate + '/')) {
            // 根目录重新创建时没有父 watcher，由下一次显式重启恢复。已知子目录由父目录事件重建。
            await register(candidate);
            changes.directories.push(candidate);
          } else if (stats.isFile() && mimeTypes.isAsset(candidate)) {
            changes.paths.push(candidate);
          }
        } catch (error) {
          if (!isMissingLibraryPath(error)) {
            onError(error);
          } else if (entry.directory) {
            unwatch(candidate);
            changes.directories.push(candidate);
          } else if (mimeTypes.isAsset(candidate)) {
            changes.paths.push(candidate);
          }
        }
      }
      if (!closed && (changes.paths.length > 0 || changes.directories.length > 0)) {
        await submit(changes);
      }
    } finally {
      flushing = false;
      schedule();
    }
  };

  /** 停止接收事件，释放监听和尚未提交的内存事件。 */
  const close = () => {
    closed = true;
    clearTimeout(timer);
    pending.clear();
    unwatch(root);
  };

  try {
    await register(root);
  } catch (error) {
    close();
    throw error;
  }
  return { close, count: watchers.size };
}
