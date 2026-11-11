import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/** 通过 Immich 登录边界进入独立后期工作台。 */
export const load = (async ({ url }) => {
  await authenticate(url);
  const translate = await getFormatter();
  return { meta: { title: translate('photo_edit_advice') } };
}) satisfies PageLoad;
