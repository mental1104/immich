<script lang="ts">
  import Dropdown from '$lib/elements/Dropdown.svelte';
  import GroupTab from '$lib/elements/GroupTab.svelte';
  import SearchBar from '$lib/elements/SearchBar.svelte';
  import {
    AlbumFilter,
    AlbumGroupBy,
    AlbumSortBy,
    AlbumViewMode,
    albumViewSettings,
    SortOrder,
  } from '$lib/stores/preferences.store';
  import {
    type AlbumGroupOptionMetadata,
    type AlbumSortOptionMetadata,
    collapseAllAlbumGroups,
    createAlbumAndRedirect,
    expandAllAlbumGroups,
    findFilterOption,
    findGroupOptionMetadata,
    findSortOptionMetadata,
    getSelectedAlbumGroupOption,
    groupOptionsMetadata,
    sortOptionsMetadata,
  } from '$lib/utils/album-utils';
  import { Button, IconButton, modalManager, Text } from '@immich/ui';
  import {
    mdiArrowDownThin,
    mdiArrowUpThin,
    mdiCheckboxMultipleMarkedOutline,
    mdiFolderEditOutline,
    mdiFolderArrowDownOutline,
    mdiFolderArrowUpOutline,
    mdiFolderRemoveOutline,
    mdiFormatListBulletedSquare,
    mdiPlusBoxOutline,
    mdiUnfoldLessHorizontal,
    mdiUnfoldMoreHorizontal,
    mdiViewGridOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { fly } from 'svelte/transition';
  import BulkAlbumCustomGroupModal from '$lib/modals/BulkAlbumCustomGroupModal.svelte';
  import AddUsersModal from '$lib/modals/AddUsersModal.svelte';
  import { handleAddUsersToAlbums, handleDeleteAlbums, isAlbumOwner } from '$lib/services/album.service';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { mdiShareVariantOutline, mdiTrashCanOutline } from '@mdi/js';

  interface Props {
    albumGroups: string[];
    selectableAlbumIds: string[];
    selectedAlbumIds: string[];
    selectedAlbums: AlbumResponseDto[];
    selectionMode: boolean;
    searchQuery: string;
    onSearch: (options: { force?: boolean }) => void;
    onReset: () => void;
    onSelectAll: () => void;
    onSetSelectionMode: (enabled: boolean) => void;
    onClearSelection: () => void;
  }

  let {
    albumGroups,
    selectableAlbumIds,
    selectedAlbumIds,
    selectedAlbums,
    selectionMode,
    searchQuery = $bindable(),
    onSearch,
    onReset,
    onSelectAll,
    onSetSelectionMode,
    onClearSelection,
  }: Props = $props();

  const flipOrdering = (ordering: string) => {
    return ordering === SortOrder.Asc ? SortOrder.Desc : SortOrder.Asc;
  };

  const handleChangeAlbumFilter = (filter: string, defaultFilter: AlbumFilter) => {
    $albumViewSettings.filter =
      Object.keys(albumFilterNames).find((key) => albumFilterNames[key as AlbumFilter] === filter) ?? defaultFilter;
  };

  const handleChangeGroupBy = ({ id, defaultOrder }: AlbumGroupOptionMetadata) => {
    if ($albumViewSettings.groupBy === id) {
      $albumViewSettings.groupOrder = flipOrdering($albumViewSettings.groupOrder);
    } else {
      $albumViewSettings.groupBy = id;
      $albumViewSettings.groupOrder = defaultOrder;
    }
  };

  const handleChangeSortBy = ({ id, defaultOrder }: AlbumSortOptionMetadata) => {
    if ($albumViewSettings.sortBy === id) {
      $albumViewSettings.sortOrder = flipOrdering($albumViewSettings.sortOrder);
    } else {
      $albumViewSettings.sortBy = id;
      $albumViewSettings.sortOrder = defaultOrder;
    }
  };

  const handleChangeListMode = () => {
    $albumViewSettings.view =
      $albumViewSettings.view === AlbumViewMode.Cover ? AlbumViewMode.List : AlbumViewMode.Cover;
  };

  let groupIcon = $derived.by(() => {
    if (selectedGroupOption?.id === AlbumGroupBy.None) {
      return mdiFolderRemoveOutline;
    }
    return $albumViewSettings.groupOrder === SortOrder.Desc ? mdiFolderArrowDownOutline : mdiFolderArrowUpOutline;
  });

  let albumFilterNames: Record<AlbumFilter, string> = $derived({
    [AlbumFilter.All]: $t('all'),
    [AlbumFilter.Owned]: $t('owned'),
    [AlbumFilter.Shared]: $t('shared'),
  });

  let selectedFilterOption = $derived(albumFilterNames[findFilterOption($albumViewSettings.filter)]);
  let selectedSortOption = $derived(findSortOptionMetadata($albumViewSettings.sortBy));
  let selectedGroupOption = $derived(findGroupOptionMetadata($albumViewSettings.groupBy));
  let sortIcon = $derived($albumViewSettings.sortOrder === SortOrder.Desc ? mdiArrowDownThin : mdiArrowUpThin);
  let allVisibleSelected = $derived(
    selectableAlbumIds.length > 0 && selectableAlbumIds.every((id) => selectedAlbumIds.includes(id)),
  );

  const openBulkCustomGroupModal = () => {
    void modalManager.show(BulkAlbumCustomGroupModal, {
      albumIds: selectedAlbumIds,
      onDone: onClearSelection,
    });
  };

  let ownedSelectedAlbums = $derived(selectedAlbums.filter(isAlbumOwner));
  const openBulkShareModal = () => {
    const albums = ownedSelectedAlbums;
    if (albums.length === 0) return;
    const presentInEveryAlbum = albums[0].albumUsers
      .map(({ user }) => user.id)
      .filter((userId) => albums.every((album) => album.albumUsers.some(({ user }) => user.id === userId)));
    void modalManager.show(AddUsersModal, {
      title: $t('bulk_album_share_title', { values: { count: albums.length } }),
      description: $t('bulk_album_share_description', { values: { count: albums.length } }),
      excludedUserIds: presentInEveryAlbum,
      onAddUsers: (users) => handleAddUsersToAlbums(albums, users),
    });
  };

  let albumSortByNames: Record<AlbumSortBy, string> = $derived({
    [AlbumSortBy.Title]: $t('sort_title'),
    [AlbumSortBy.ItemCount]: $t('sort_items'),
    [AlbumSortBy.DateModified]: $t('sort_modified'),
    [AlbumSortBy.DateCreated]: $t('sort_created'),
    [AlbumSortBy.MostRecentPhoto]: $t('sort_recent'),
    [AlbumSortBy.OldestPhoto]: $t('sort_oldest'),
  });

  let albumGroupByNames: Record<AlbumGroupBy, string> = $derived({
    [AlbumGroupBy.None]: $t('group_no'),
    [AlbumGroupBy.Owner]: $t('group_owner'),
    [AlbumGroupBy.Year]: $t('group_year'),
    [AlbumGroupBy.Custom]: $t('group_custom'),
  });
</script>

<!-- Filter Albums by Sharing Status (All, Owned, Shared) -->
<div class="hidden h-10 xl:block">
  <GroupTab
    label={$t('show_albums')}
    filters={Object.values(albumFilterNames)}
    selected={selectedFilterOption}
    onSelect={(selected) => handleChangeAlbumFilter(selected, AlbumFilter.All)}
  />
</div>

<Button
  leadingIcon={mdiCheckboxMultipleMarkedOutline}
  aria-label={$t(selectionMode ? 'cancel_album_selection' : 'select_albums')}
  title={$t(selectionMode ? 'cancel_album_selection' : 'select_albums')}
  onclick={() => onSetSelectionMode(!selectionMode)}
  size="small"
  variant="ghost"
  color="secondary"
>
  <Text class="hidden md:block">{$t(selectionMode ? 'cancel_album_selection' : 'select_albums')}</Text>
</Button>

{#if selectionMode}
  <Button
    leadingIcon={mdiCheckboxMultipleMarkedOutline}
    aria-label={$t(allVisibleSelected ? 'deselect_all_filtered_albums' : 'select_all_filtered_albums')}
    title={$t(allVisibleSelected ? 'deselect_all_filtered_albums' : 'select_all_filtered_albums')}
    onclick={onSelectAll}
    disabled={selectableAlbumIds.length === 0}
    size="small"
    variant="ghost"
    color="secondary"
  >
    <Text class="hidden md:block"
      >{$t(allVisibleSelected ? 'deselect_all_filtered_albums' : 'select_all_filtered_albums')}</Text
    >
  </Button>
{/if}

{#if selectedAlbumIds.length > 0}
  <Button
    leadingIcon={mdiFolderEditOutline}
    aria-label={$t('set_custom_group_count', { values: { count: selectedAlbumIds.length } })}
    title={$t('set_custom_group_count', { values: { count: selectedAlbumIds.length } })}
    onclick={openBulkCustomGroupModal}
    size="small"
    variant="ghost"
    color="secondary"
  >
    <Text class="hidden md:block">{$t('set_custom_group_count', { values: { count: selectedAlbumIds.length } })}</Text>
  </Button>
{/if}

{#if ownedSelectedAlbums.length > 0}
  <Button
    leadingIcon={mdiShareVariantOutline}
    aria-label={$t('bulk_album_share_button', { values: { count: ownedSelectedAlbums.length } })}
    title={$t('bulk_album_share_button', { values: { count: ownedSelectedAlbums.length } })}
    onclick={openBulkShareModal}
    size="small"
    variant="ghost"
    color="secondary"
  >
    <Text class="hidden md:block"
      >{$t('bulk_album_share_button', { values: { count: ownedSelectedAlbums.length } })}</Text
    >
  </Button>
  <Button
    leadingIcon={mdiTrashCanOutline}
    aria-label={$t('bulk_album_delete_button', { values: { count: ownedSelectedAlbums.length } })}
    title={$t('bulk_album_delete_button', { values: { count: ownedSelectedAlbums.length } })}
    onclick={() => void handleDeleteAlbums(ownedSelectedAlbums)}
    size="small"
    variant="ghost"
    color="secondary"
  >
    <Text class="hidden md:block"
      >{$t('bulk_album_delete_button', { values: { count: ownedSelectedAlbums.length } })}</Text
    >
  </Button>
{/if}

<!-- Search Albums -->
<div class="hidden h-10 xl:block xl:w-60 2xl:w-80">
  <SearchBar
    placeholder={$t('search_albums_and_groups')}
    bind:name={searchQuery}
    {onSearch}
    {onReset}
    showLoadingSpinner={false}
  />
</div>

<!-- Create Album -->
<Button
  leadingIcon={mdiPlusBoxOutline}
  onclick={() => createAlbumAndRedirect()}
  size="small"
  variant="ghost"
  color="secondary"
>
  <p class="hidden md:block">{$t('create_album')}</p>
</Button>

<!-- Sort Albums -->
<Dropdown
  title={$t('sort_albums_by')}
  options={Object.values(sortOptionsMetadata)}
  selectedOption={selectedSortOption}
  onSelect={handleChangeSortBy}
  render={({ id }) => ({
    title: albumSortByNames[id],
    icon: sortIcon,
  })}
/>

<!-- Group Albums -->
<Dropdown
  title={$t('group_albums_by')}
  options={Object.values(groupOptionsMetadata)}
  selectedOption={selectedGroupOption}
  onSelect={handleChangeGroupBy}
  render={({ id, isDisabled }) => ({
    title: albumGroupByNames[id],
    icon: groupIcon,
    disabled: isDisabled(),
  })}
/>

{#if getSelectedAlbumGroupOption($albumViewSettings) !== AlbumGroupBy.None}
  <span in:fly={{ x: -50, duration: 250 }}>
    <!-- Expand Album Groups -->
    <div class="hidden gap-0 xl:flex">
      <div class="block">
        <IconButton
          title={$t('expand_all')}
          onclick={() => expandAllAlbumGroups()}
          variant="ghost"
          color="secondary"
          shape="round"
          icon={mdiUnfoldMoreHorizontal}
          aria-label={$t('expand_all')}
        />
      </div>

      <!-- Collapse Album Groups -->
      <div class="block">
        <IconButton
          title={$t('collapse_all')}
          onclick={() => collapseAllAlbumGroups(albumGroups)}
          variant="ghost"
          color="secondary"
          shape="round"
          icon={mdiUnfoldLessHorizontal}
          aria-label={$t('collapse_all')}
        />
      </div>
    </div>
  </span>
{/if}

<!-- Cover/List Display Toggle -->
{#if $albumViewSettings.view === AlbumViewMode.List}
  <Button
    leadingIcon={mdiViewGridOutline}
    onclick={() => handleChangeListMode()}
    size="small"
    variant="ghost"
    color="secondary"
  >
    <Text class="hidden md:block">{$t('covers')}</Text>
  </Button>
{:else}
  <Button
    leadingIcon={mdiFormatListBulletedSquare}
    onclick={() => handleChangeListMode()}
    size="small"
    variant="ghost"
    color="secondary"
  >
    <Text class="hidden md:block">{$t('list')}</Text>
  </Button>
{/if}
