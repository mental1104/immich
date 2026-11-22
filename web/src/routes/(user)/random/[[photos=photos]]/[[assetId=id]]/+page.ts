import { queryClient } from '#lib/queries/client.ts';
import { getRandomPhotosQuery } from '#lib/queries/search.query.ts';
import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import type { PageLoad } from './$types';

/** url 为当前地址；鉴权后加载一批随机照片及标题，加载失败进入路由错误页。 */
export const load = (async ({ url }) => {
  await authenticate(url);
  await queryClient.query(getRandomPhotosQuery());
  const $t = await getFormatter();
  return { meta: { title: $t('random_photos') } };
}) satisfies PageLoad;
