import { asMutation, queryClient } from '#lib/queries/client.ts';
import { getBaseUrl } from '@immich/sdk';
import { queryOptions } from '@tanstack/svelte-query';

/** 个人目录只包含可选父节点与原分组名称的对应关系；缺少映射表示默认。 */
export interface AlbumCategoryState {
  categories: { id: string; name: string }[];
  groups: { groupName: string; categoryId: string }[];
}

export const albumCategoriesQueryKey = ['fork-album-categories'];

/** @param signal 页面卸载取消信号。@returns 当前账号目录；失败时保留错误供界面重试。 */
export async function readAlbumCategories(signal?: AbortSignal): Promise<AlbumCategoryState> {
  const response = await fetch(`${getBaseUrl()}/fork/album-categories`, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`Album category read failed: ${response.status}`);
  return response.json();
}

/** @returns 独立于相簿缓存的个人目录查询，每次进入页面重新核对归属。 */
export const getAlbumCategoriesQuery = () =>
  queryOptions({
    queryKey: albumCategoriesQueryKey,
    queryFn: ({ signal }) => readAlbumCategories(signal),
    staleTime: 0,
  });

/** 大组管理的单次写命令，不修改官方API和手机SDK。 */
export type AlbumCategoryCommand =
  | { method: 'POST'; name: string }
  | { method: 'PATCH'; id: string; name: string }
  | { method: 'DELETE'; id: string }
  | { method: 'PUT'; groupName: string; categoryId: string | null };

/** @param command 当前用户目录的一次操作。@returns 写入完成；失败拒绝且不更新缓存。 */
export async function writeAlbumCategory(command: AlbumCategoryCommand): Promise<void> {
  const suffix = command.method === 'PUT' ? '/group' : 'id' in command ? `/${command.id}` : '';
  const response = await fetch(`${getBaseUrl()}/fork/album-categories${suffix}`, {
    method: command.method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: command.method === 'DELETE' ? undefined : JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Album category update failed: ${response.status}`);
}

/** @returns 写后失效个人目录缓存，所有使用中的筛选立即按新归属刷新。 */
export const albumCategoryMutation = () =>
  asMutation(writeAlbumCategory, {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: albumCategoriesQueryKey }),
    meta: { error: { toast: 'errors.unable_to_update_album_info' } },
  });
