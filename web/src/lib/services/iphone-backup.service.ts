import { getBaseUrl } from '@immich/sdk';

/** Fork 管理接口的状态；由独立命名空间提供，不向官方移动端 SDK 添加类型。 */
export interface IphoneBackupProgress {
  enabled: boolean;
  uploadsEnabled: boolean;
  continuous: boolean;
  total: number;
  ready: number;
  pending: number;
  state: 'disabled' | 'idle' | 'queued' | 'running' | 'paused' | 'failed' | 'completed';
  batch: {
    completed: number;
    bytes: number;
    currentAssetId?: string;
    errorCode?: string;
    reason?: 'limit' | 'budget' | 'paused' | 'complete';
  } | null;
}

/** 只控制有界后台批次，不提供上传开关。 */
export type IphoneBackupCommand = 'start' | 'continue' | 'pause' | 'resume' | 'retry';

/**
 * 读取或更新 Fork 匹配准备状态，沿用同源登录 Cookie。
 * @param command 省略时只读取状态；每批最多处理 5000 张、8 GiB，continue 显式开启接续。
 * @returns 服务端状态；鉴权、网络或非成功响应抛错，页面保留上次数据并标记过期。
 */
export async function requestIphoneBackupProgress(command?: IphoneBackupCommand): Promise<IphoneBackupProgress> {
  const response = await fetch(`${getBaseUrl()}/admin/fork/iphone-backup`, {
    method: command ? 'PUT' : 'GET',
    credentials: 'include',
    headers: command ? { 'Content-Type': 'application/json' } : undefined,
    body: command ? JSON.stringify({ command, limit: 5000 }) : undefined,
  });
  if (!response.ok) {
    throw new Error(`Fingerprint request failed: ${response.status}`);
  }
  return response.json();
}
