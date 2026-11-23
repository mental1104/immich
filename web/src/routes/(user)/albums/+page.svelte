<script lang="ts">
  import { scrollMemory } from '#lib/actions/scroll-memory.svelte.ts';
  import Albums from '#lib/components/album-page/AlbumsList.svelte';
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '#lib/components/shared-components/EmptyPlaceholder.svelte';
  import AlbumCategoryModal from '#lib/modals/AlbumCategoryModal.svelte';
  import { getAlbumCategoriesQuery } from '#lib/queries/album-category.query.ts';
  import { getAllAlbumsQuery } from '#lib/queries/album.query.ts';
  import { createPreloadedQuery, queryClient } from '#lib/queries/client.ts';
  import { Route } from '#lib/route.ts';
  import { isAlbumOwner } from '#lib/services/album.service.ts';
  import { AlbumFilter, albumViewSettings } from '#lib/stores/preferences.store.ts';
  import { createAlbumAndRedirect, findFilterOption } from '#lib/utils/album-utils.ts';
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
  let groupName = $state<string | null>(null);
  const categoryName = $derived(
    categoryId === null
      ? $t('all_albums')
      : (directory.data?.categories.find((category) => category.id === categoryId)?.name ??
          $t('album_category_default')),
  );
  // 左栏数量跟随所有权和大组，文字搜索不隐藏导航，方便在搜索中继续切换分组。
  const categoryAlbums = $derived(
    allAlbums.filter((album) => {
      const filter = findFilterOption($albumViewSettings.filter);
      if (filter === AlbumFilter.Owned && !isAlbumOwner(album)) return false;
      if (filter === AlbumFilter.Shared && sharedAlbums.every(({ id }) => id !== album.id)) return false;
      const parent =
        directory.data?.groups.find((group) => group.groupName === (album.customGroupName?.trim() || ''))?.categoryId ??
        '';
      return categoryId === null || parent === categoryId;
    }),
  );
  const navigationGroups = $derived(
    [...new Set(categoryAlbums.map((album) => album.customGroupName?.trim() || ''))]
      .sort((a, b) => (a ? (b ? a.localeCompare(b) : -1) : 1))
      .map((name) => ({
        name,
        count: categoryAlbums.filter((album) => (album.customGroupName?.trim() || '') === name).length,
      })),
  );

  /** 切换顶部大组时回到其全部分组；id为null时跨大组，空字符串为默认大组。 */
  function selectCategory(id: string | null) {
    categoryId = id;
    groupName = null;
  }

  // 删除/移动分组或切换所有权后清除已失效的左栏选择，保留跨范围的相簿勾选。
  $effect(() => {
    if (groupName !== null && navigationGroups.every(({ name }) => name !== groupName)) groupName = null;
  });
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
  <section class="min-w-0 rounded-xl border border-gray-200 dark:border-immich-dark-gray">
    <nav class="flex flex-wrap items-center gap-2 border-b p-3" aria-label={$t('album_categories')}>
      <Button
        size="small"
        variant={categoryId === null ? 'filled' : 'ghost'}
        aria-pressed={categoryId === null}
        onclick={() => selectCategory(null)}>{$t('all_albums')}</Button
      >
      <Button
        size="small"
        variant={categoryId === '' ? 'filled' : 'ghost'}
        aria-pressed={categoryId === ''}
        onclick={() => selectCategory('')}>{$t('album_category_default')}</Button
      >
      {#each directory.data?.categories ?? [] as category (category.id)}
        <Button
          size="small"
          variant={categoryId === category.id ? 'filled' : 'ghost'}
          aria-pressed={categoryId === category.id}
          onclick={() => selectCategory(category.id)}>{category.name}</Button
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
    </nav>

    <div
      role="group"
      aria-label={$t('album_management_toolbar')}
      class="flex flex-wrap items-center gap-2 border-b p-3"
    >
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
      <Button
        size="small"
        variant="ghost"
        aria-pressed={!($albumViewSettings.coversOnly ?? true)}
        onclick={() => ($albumViewSettings.coversOnly = !($albumViewSettings.coversOnly ?? true))}
        >{$t(($albumViewSettings.coversOnly ?? true) ? 'album_show_details' : 'album_covers_only')}</Button
      >
    </div>

    <div class="grid min-w-0 md:grid-cols-[180px_minmax(0,1fr)]">
      <nav
        aria-label={$t('album_group_navigation')}
        class="flex gap-1 overflow-x-auto border-b bg-gray-50 p-2 md:block md:overflow-visible md:border-e md:border-b-0 dark:bg-immich-dark-gray/20"
      >
        <h2
          class="hidden w-full px-3 py-2 text-sm font-semibold text-immich-fg/70 md:block dark:text-immich-dark-fg/70"
        >
          {$t('group_custom')}
        </h2>
        <button
          type="button"
          class="mb-1 flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-gray-100 md:w-full dark:hover:bg-immich-dark-gray {groupName ===
          null
            ? 'bg-immich-primary/10'
            : ''}"
          aria-pressed={groupName === null}
          onclick={() => (groupName = null)}
        >
          <span class="grow whitespace-nowrap md:whitespace-normal">{$t('album_all_groups')}</span><span
            class="text-immich-fg/70 tabular-nums dark:text-immich-dark-fg/70">{categoryAlbums.length}</span
          >
        </button>
        {#each navigationGroups as group (group.name)}
          <button
            type="button"
            class="mb-1 flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-gray-100 md:w-full dark:hover:bg-immich-dark-gray {groupName ===
            group.name
              ? 'bg-immich-primary/10'
              : ''}"
            aria-pressed={groupName === group.name}
            onclick={() => (groupName = group.name)}
          >
            <span class="grow whitespace-nowrap md:break-all md:whitespace-normal">{group.name || $t('ungrouped')}</span
            ><span class="text-immich-fg/70 tabular-nums dark:text-immich-dark-fg/70">{group.count}</span>
          </button>
        {/each}
      </nav>
      <div class="min-w-0 p-3 md:p-4">
        <p class="mb-2 text-sm text-immich-fg/70 dark:text-immich-dark-fg/70">
          {categoryName}{groupName === null ? '' : ` / ${groupName || $t('ungrouped')}`}
        </p>
        <h2 class="mb-3 text-lg font-semibold">{groupName === null ? categoryName : groupName || $t('ungrouped')}</h2>
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
          {groupName}
          compact
          coversOnly={$albumViewSettings.coversOnly ?? true}
        >
          {#snippet empty()}
            <EmptyPlaceholder
              text={$t('no_albums_message')}
              onClick={() => createAlbumAndRedirect()}
              class="mx-auto mt-10"
            />
          {/snippet}
        </Albums>
      </div>
    </div>
  </section>
</UserPageLayout>
