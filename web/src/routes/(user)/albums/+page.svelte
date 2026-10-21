<script lang="ts">
  import { scrollMemory } from '$lib/actions/scroll-memory';
  import AlbumsControls from './AlbumsControls.svelte';
  import Albums from '$lib/components/album-page/AlbumsList.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import GroupTab from '$lib/elements/GroupTab.svelte';
  import SearchBar from '$lib/elements/SearchBar.svelte';
  import { Route } from '$lib/route';
  import { AlbumFilter, albumViewSettings } from '$lib/stores/preferences.store';
  import { createAlbumAndRedirect } from '$lib/utils/album-utils';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let searchQuery = $state('');
  let searchInput = $state('');

  const onSearch = ({ force }: { force?: boolean }) => {
    if (force) searchQuery = searchInput;
  };
  const onReset = () => {
    searchQuery = '';
  };
  let albumGroups: string[] = $state([]);
  let selectableAlbumIds: string[] = $state([]);
  let selectedAlbumIds: string[] = $state([]);
  let selectionMode = $state(false);
  let selectedAlbums = $derived(
    [...new Map([...data.albums, ...data.sharedAlbums].map((album) => [album.id, album])).values()].filter((album) =>
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

<UserPageLayout title={data.meta.title} use={[[scrollMemory, { routeStartsWith: Route.albums() }]]}>
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

  <Albums
    ownedAlbums={data.albums}
    sharedAlbums={data.sharedAlbums}
    userSettings={$albumViewSettings}
    allowEdit
    {selectionMode}
    {selectedAlbumIds}
    onAlbumSelect={toggleAlbumSelection}
    bind:selectableAlbumIds
    {searchQuery}
    bind:albumGroupIds={albumGroups}
  >
    {#snippet empty()}
      <EmptyPlaceholder text={$t('no_albums_message')} onClick={() => createAlbumAndRedirect()} class="mx-auto mt-10" />
    {/snippet}
  </Albums>
</UserPageLayout>
