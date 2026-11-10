import { getBaseUrl } from '@immich/sdk';

/** Fork 原生助手的显示合同；独立于官方客户端 SDK，原片路径不进入浏览器响应。 */
export interface PhotoCopilotSnapshot {
  id: string;
  assetId: string;
  fileName: string;
  context: object;
  image: 'original' | 'converted' | 'embedded-preview' | 'preview' | 'unavailable';
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'completed' | 'interrupted' | 'failed';
  busy: boolean;
  error: string | null;
  messages: { id: string; role: 'user' | 'assistant'; text: string }[];
}

/**
 * 用现有同源 Cookie 访问照片助手；无需侧栏配对或额外登录。
 * @param assetId 当前照片 ID，不允许传入磁盘路径。
 * @param suffix sessions 或具体会话下的 messages/stop。
 * @param body 可选会话 ID 或用户消息；总是 POST，不能执行照片修改。
 * @param signal 面板关闭/切图的请求取消信号；只取消传输。
 * @returns 后台快照；HTTP 错误保留状态码用于会话过期恢复。
 */
export async function requestPhotoCopilot(
  assetId: string,
  suffix: string,
  body: object,
  signal?: AbortSignal,
): Promise<PhotoCopilotSnapshot> {
  const response = await fetch(`${getBaseUrl()}/fork/photo-copilot/assets/${encodeURIComponent(assetId)}/${suffix}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Object.assign(
      new Error(typeof error.message === 'string' ? error.message : `Photo Copilot request failed: ${response.status}`),
      { status: response.status },
    );
  }
  return response.json();
}

/** @param assetId 当前照片。@param id 已建立的会话。@returns SSE 地址，沿用现有登录 Cookie，不在 URL 放令牌。 */
export function photoCopilotEventsUrl(assetId: string, id: string): string {
  return `${getBaseUrl()}/fork/photo-copilot/assets/${encodeURIComponent(assetId)}/sessions/${encodeURIComponent(id)}/events`;
}
