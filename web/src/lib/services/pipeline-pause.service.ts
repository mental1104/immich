import { getBaseUrl, type QueueName } from '@immich/sdk';

/** Fork 管理接口的暂停意图，UTC Unix 毫秒期限在重启后保持不变。 */
export interface PipelinePausePolicy {
  enabled: boolean;
  durationMs: number;
  queues: {
    name: QueueName;
    isPaused: boolean;
    pause: {
      mode: 'temporary' | 'persistent';
      pausedAt: number;
      resumeAt: number | null;
    } | null;
  }[];
}

/**
 * @param command 省略时只读取；显式 persistent 才创建长期维护暂停。
 * @returns 管理策略；鉴权、网络及非成功响应抛错，页面不得把旧数据当实时结果。
 */
export async function requestPipelinePause(command?: {
  name: QueueName;
  mode: 'persistent' | 'resume';
}): Promise<PipelinePausePolicy> {
  const response = await fetch(`${getBaseUrl()}/admin/fork/pipeline${command ? `/${command.name}` : ''}`, {
    method: command ? 'PUT' : 'GET',
    credentials: 'include',
    headers: command ? { 'Content-Type': 'application/json' } : undefined,
    body: command ? JSON.stringify({ mode: command.mode }) : undefined,
  });
  if (!response.ok) {
    throw new Error(`Pipeline pause request failed: ${response.status}`);
  }
  return response.json();
}
