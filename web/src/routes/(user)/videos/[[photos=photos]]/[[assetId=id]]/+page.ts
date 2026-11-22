import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import type { PageLoad } from './$types';

/** url 为当前地址；鉴权后返回视频页标题，失败沿用路由错误处理。 */
export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  return {
    meta: {
      title: $t('videos'),
    },
  };
}) satisfies PageLoad;
