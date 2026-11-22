<script lang="ts">
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import GalleryViewer from '#lib/components/shared-components/gallery-viewer/GalleryViewer.svelte';
  import AssetSelectControlBar from '#lib/components/timeline/AssetSelectControlBar.svelte';
  import { assetMultiSelectManager } from '#lib/managers/asset-multi-select-manager.svelte.ts';
  import { createPreloadedQuery } from '#lib/queries/client.ts';
  import { getRandomPhotosQuery } from '#lib/queries/search.query.ts';
  import { getAssetBulkActions } from '#lib/services/asset.service.ts';
  import { ActionButton, Button } from '@immich/ui';
  import { mdiShuffleVariant } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const query = createPreloadedQuery(getRandomPhotosQuery);
  let viewport = $state({ width: 0, height: 0 });
  let scrollTop = $state(0);
  let scrollContainer = $state<HTMLDivElement>();
  // 使用本地副本，让查看器的删除等操作不会直接改写查询缓存。
  // eslint-disable-next-line svelte/prefer-writable-derived -- 查看器原地 splice 和修改资产，需要深层响应式副本。
  let assets = $state([...query.data]);
  $effect(() => {
    assets = [...query.data];
  });

  /** event 来自当前内部滚动容器；同步偏移供网格计算可见缩略图，无返回值。 */
  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    scrollTop = event.currentTarget.scrollTop;
  };

  /** 清除当前选择并重新抽取；请求失败保留旧照片，由全局查询处理显示错误。 */
  const refresh = async () => {
    assetMultiSelectManager.clear();
    scrollTop = 0;
    scrollContainer?.scrollTo({ top: 0 });
    await query.refetch();
  };
</script>

<UserPageLayout title={$t('random_photos')} hideNavbar={assetMultiSelectManager.selectionActive} scrollbar={false}>
  {#snippet buttons()}
    <Button leadingIcon={mdiShuffleVariant} disabled={query.isFetching} onclick={refresh}>{$t('shuffle_photos')}</Button
    >
  {/snippet}
  <div
    class="h-full overflow-y-auto"
    bind:this={scrollContainer}
    bind:clientHeight={viewport.height}
    onscroll={handleScroll}
  >
    <div bind:clientWidth={viewport.width}>
      <GalleryViewer bind:assets assetInteraction={assetMultiSelectManager} {viewport} {scrollTop} onReload={refresh} />
      {#if assets.length === 0}<p class="mt-10 text-center">{$t('no_assets_message')}</p>{/if}
    </div>
  </div>
</UserPageLayout>

{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    {const actions = $derived(getAssetBulkActions($t))}
    <ActionButton action={actions.AddToAlbum} />
    <ActionButton action={actions.CreateSharedLink} />
  </AssetSelectControlBar>
{/if}
