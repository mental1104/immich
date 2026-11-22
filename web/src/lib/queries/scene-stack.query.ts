import { getBaseUrl } from '@immich/sdk';

/** 一个完整外层分组；成员仍是原生叠放的封面或单张，不包含原生隐藏成员。 */
export interface SceneStackGroup {
  id: string;
  coverId: string;
  members: string[];
}

/** @param ids 当前时间桶ID。@param signal 桶卸载时取消。@returns 当前登录可用的完整分组，服务未部署则保留原生展示。 */
export async function querySceneStacks(ids: string[], signal: AbortSignal): Promise<SceneStackGroup[]> {
  const groups: SceneStackGroup[] = [];
  // 超大月份拆请求；跨请求的组保留展开，不能只折叠半个组。
  for (let offset = 0; offset < ids.length; offset += 5000) {
    const response = await fetch(`${getBaseUrl()}/fork/scene-stacks/query`, {
      method: 'POST',
      credentials: 'include',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids.slice(offset, offset + 5000) }),
    });
    if (!response.ok) {
      return [];
    }
    const reply: { groups: SceneStackGroup[] } = await response.json();
    groups.push(...reply.groups);
  }
  return groups;
}
