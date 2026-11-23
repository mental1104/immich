import { asMutation, queryClient } from '#lib/queries/client.ts';
import type { SearchPresetConditions } from '#lib/utils/search-presets.ts';
import { getBaseUrl } from '@immich/sdk';
import { queryOptions } from '@tanstack/svelte-query';

/** 当前账号登记项；内置登记项不存储在用户表中。 */
export interface SearchPreset {
  id: string;
  name: string;
  conditions: SearchPresetConditions;
}
export const searchPresetsQueryKey = ['fork-search-presets'];

/** @param signal 关闭页面时取消。@returns 当前账号全部登记项；失败由弹框提供重试。 */
export async function readSearchPresets(signal?: AbortSignal): Promise<SearchPreset[]> {
  const response = await fetch(`${getBaseUrl()}/fork/search-presets`, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`Search preset read failed: ${response.status}`);
  return response.json();
}

/** @returns 每次打开核对账号登记项的独立查询。 */
export const getSearchPresetsQuery = () =>
  queryOptions({ queryKey: searchPresetsQueryKey, queryFn: ({ signal }) => readSearchPresets(signal), staleTime: 0 });

/** 单次登记写命令；没有客户端提供的用户范围。 */
export type SearchPresetCommand =
  | { method: 'POST' | 'PATCH'; id?: string; name: string; conditions: SearchPresetConditions }
  | { method: 'DELETE'; id: string };

/** @param command 自有登记项的新增、覆盖或删除。@returns 写入完成；失败不修改缓存。 */
export async function writeSearchPreset(command: SearchPresetCommand): Promise<void> {
  const suffix = command.method === 'POST' ? '' : `/${command.id}`;
  const response = await fetch(`${getBaseUrl()}/fork/search-presets${suffix}`, {
    method: command.method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: command.method === 'DELETE' ? undefined : JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Search preset update failed: ${response.status}`);
}

/** @returns 写入成功后刷新个人登记缓存，失败由共享错误处理显示。 */
export const searchPresetMutation = () =>
  asMutation(writeSearchPreset, {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: searchPresetsQueryKey }),
    meta: { error: { toast: 'errors.something_went_wrong' } },
  });
