<script lang="ts">
  import { scrollMemory } from '#lib/actions/scroll-memory.svelte.ts';
  import Albums from '#lib/components/album-page/AlbumsList.svelte';
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '#lib/components/shared-components/EmptyPlaceholder.svelte';
  import GroupTab from '#lib/elements/GroupTab.svelte';
  import SearchBar from '#lib/elements/SearchBar.svelte';
  import AlbumCategoryModal from '#lib/modals/AlbumCategoryModal.svelte';
  import { getAlbumCategoriesQuery } from '#lib/queries/album-category.query.ts';
  import { getAllAlbumsQuery } from '#lib/queries/album.query.ts';
  import { createPreloadedQuery, queryClient } from '#lib/queries/client.ts';
  import { Route } from '#lib/route.ts';
  import { AlbumFilter, albumViewSettings } from '#lib/stores/preferences.store.ts';
  import { createAlbumAndRedirect } from '#lib/utils/album-utils.ts';
  import { Button, modalManager } from '@immich/ui';
  import { createQuery } from '@tanstack/svelte-query';
  import { noop } from 'lodash-es';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';
  import AlbumsControls from './AlbumsControls.svelte';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const queries = {
    ownedAlbums: createPreloadedQuery(() => getAllAlbumsQuery({ isOwned: true })),
    sharedAlbums: createPreloadedQuery(() => getAllAlbumsQuery({ isShared: true })),
  };

  // 仅在普通相簿页排除待整理分组，保留共享查询缓存供专用入口和相簿详情使用。
  // album 是 API 返回的相簿；严格匹配去除首尾空白后的分组名，其他分组照常显示。
  const ownedAlbums = $derived(queries.ownedAlbums.data.filter((album) => album.customGroupName?.trim() !== '待整理'));
  const sharedAlbums = $derived(
    queries.sharedAlbums.data.filter((album) => album.customGroupName?.trim() !== '待整理'),
  );
  const directory = createQuery(getAlbumCategoriesQuery, () => queryClient);
  const allAlbums = $derived([
    ...new Map([...ownedAlbums, ...sharedAlbums].map((album) => [album.id, album])).values(),
  ]);
  const groupNames = $derived([...new Set(allAlbums.map((album) => album.customGroupName?.trim() || ''))].sort());
  let categoryId = $state<string | null>(null);
  // 删除当前大组后回全部，避免继续使用已经不存在的父节点而显示空白。
  $effect(() => {
    if (categoryId && directory.data && directory.data.categories.every((category) => category.id !== categoryId))
      categoryId = null;
  });

  let searchInput = $state('');
  const searchQuery = $derived(searchInput);

  // 绑定值直接驱动筛选，避免oninput先于bind更新时读取上一字符。
  const onSearch = noop;
  const onReset = () => {
    searchInput = '';
  };
  let albumGroups: string[] = $state([]);
  let selectableAlbumIds: string[] = $state([]);
  let selectedAlbumIds: string[] = $state([]);
  let selectionMode = $state(false);
  let selectedAlbums = $derived(
    [...new Map([...ownedAlbums, ...sharedAlbums].map((album) => [album.id, album])).values()].filter((album) =>
      selectedAlbumIds.includes(album.id),
    ),
  );

  const toggleAlbumSelection = (albumId: string) => {
    selectedAlbumIds = selectedAlbumIds.includes(albumId)
      ? selectedAlbumIds.filter((id) => id !== albumId)
      : [...selectedAlbumIds, albumId];
  };

  const selectAllAlbums = () => {
    const allSelected = selectableAlbumIds.every((id) => selectedAlbumIds.includes(id));
    selectedAlbumIds = allSelected
      ? selectedAlbumIds.filter((id) => !selectableAlbumIds.includes(id))
      : [...new Set([...selectedAlbumIds, ...selectableAlbumIds])];
  };

  const setSelectionMode = (enabled: boolean) => {
    selectionMode = enabled;
    if (!enabled) {
      selectedAlbumIds = [];
    }
  };
</script>

<UserPageLayout title={data.meta.title} {@attach scrollMemory({ routeStartsWith: Route.albums() })}>
  {#snippet buttons()}
    <div class="flex place-items-center gap-2">
      <AlbumsControls
        {albumGroups}
        {selectableAlbumIds}
        {selectedAlbumIds}
        {selectedAlbums}
        {selectionMode}
        bind:searchQuery={searchInput}
        {onSearch}
        {onReset}
        onSelectAll={selectAllAlbums}
        onSetSelectionMode={setSelectionMode}
        onClearSelection={() => (selectedAlbumIds = [])}
      />
    </div>
  {/snippet}

  <div class="xl:hidden">
    <div class="h-14 w-fit py-2 dark:text-immich-dark-fg">
      <GroupTab
        label={$t('show_albums')}
        filters={Object.keys(AlbumFilter)}
        selected={$albumViewSettings.filter}
        onSelect={(selected) => ($albumViewSettings.filter = selected)}
      />
    </div>
    <div class="w-60">
      <SearchBar
        placeholder={$t('search_albums_and_groups')}
        bind:name={searchInput}
        {onSearch}
        {onReset}
        showLoadingSpinner={false}
      />
    </div>
  </div>

  <div class="my-4 flex flex-wrap items-center gap-2" aria-label={$t('album_categories')}>
    <Button size="small" variant={categoryId === null ? 'filled' : 'ghost'} onclick={() => (categoryId = null)}
      >{$t('all_albums')}</Button
    >
    <Button size="small" variant={categoryId === '' ? 'filled' : 'ghost'} onclick={() => (categoryId = '')}
      >{$t('album_category_default')}</Button
    >
    {#each directory.data?.categories ?? [] as category (category.id)}
      <Button
        size="small"
        variant={categoryId === category.id ? 'filled' : 'ghost'}
        onclick={() => (categoryId = category.id)}>{category.name}</Button
      >
    {/each}
    <div class="grow"></div>
    {#if directory.isError}
      <Button size="small" variant="ghost" onclick={() => directory.refetch()}>{$t('album_categories_retry')}</Button>
    {:else}
      <Button
        size="small"
        variant="ghost"
        disabled={!directory.data}
        onclick={() => modalManager.show(AlbumCategoryModal, { groupNames })}>{$t('album_categories_manage')}</Button
      >
    {/if}
    <Button
      size="small"
      variant="ghost"
      aria-pressed={!($albumViewSettings.coversOnly ?? true)}
      onclick={() => ($albumViewSettings.coversOnly = !($albumViewSettings.coversOnly ?? true))}
      >{$t(($albumViewSettings.coversOnly ?? true) ? 'album_show_details' : 'album_covers_only')}</Button
    >
  </div>

  <Albums
    {ownedAlbums}
    {sharedAlbums}
    userSettings={$albumViewSettings}
    allowEdit
    {selectionMode}
    {selectedAlbumIds}
    onAlbumSelect={toggleAlbumSelection}
    bind:selectableAlbumIds
    {searchQuery}
    bind:albumGroupIds={albumGroups}
    directory={directory.data}
    {categoryId}
    compact
    coversOnly={$albumViewSettings.coversOnly ?? true}
  >
    {#snippet empty()}
      <EmptyPlaceholder text={$t('no_albums_message')} onClick={() => createAlbumAndRedirect()} class="mx-auto mt-10" />
    {/snippet}
  </Albums>
</UserPageLayout>
