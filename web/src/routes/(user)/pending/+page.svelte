<script lang="ts">
  import Albums from '#lib/components/album-page/AlbumsList.svelte';
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import { getPendingAlbumsQuery } from '#lib/queries/album.query.ts';
  import { createPreloadedQuery } from '#lib/queries/client.ts';
  import { AlbumFilter, AlbumGroupBy, albumViewSettings } from '#lib/stores/preferences.store.ts';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /** data 是鉴权加载器返回的页面标题；相簿数据由共享查询缓存提供。 */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const query = createPreloadedQuery(getPendingAlbumsQuery);
  // 入口始终展示本人待整理相簿，不让普通相簿的共享筛选或折叠分组隐藏此处内容。
  const settings = $derived({ ...$albumViewSettings, filter: AlbumFilter.Owned, groupBy: AlbumGroupBy.None });
</script>

<UserPageLayout title={data.meta.title}>
  <p class="mb-4 text-sm text-gray-500 dark:text-gray-400">{$t('pending_albums_description')}</p>
  <Albums ownedAlbums={query.data} userSettings={settings} allowEdit>
    {#snippet empty()}
      <p class="mt-10 text-center text-gray-500 dark:text-gray-400">{$t('pending_albums_empty')}</p>
    {/snippet}
  </Albums>
</UserPageLayout>
