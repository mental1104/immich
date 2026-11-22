import { getPendingAlbumsQuery } from '#lib/queries/album.query.ts';
import { queryClient } from '#lib/queries/client.ts';
import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import type { PageLoad } from './$types';

/** url 为当前页面地址；鉴权后刷新本人待整理相簿，返回页面标题，失败沿用路由错误处理。 */
export const load = (async ({ url }) => {
  await authenticate(url);
  await queryClient.query({ ...getPendingAlbumsQuery(), staleTime: 0 });
  const $t = await getFormatter();
  return { meta: { title: $t('pending_albums') } };
}) satisfies PageLoad;
