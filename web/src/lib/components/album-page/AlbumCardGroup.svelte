<script lang="ts">
  import AlbumCard from '$lib/components/album-page/AlbumCard.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { Route } from '$lib/route';
  import { getAlbumActions, isAlbumEditor } from '$lib/services/album.service';
  import { albumViewSettings } from '$lib/stores/preferences.store';
  import { type AlbumGroup, isAlbumGroupCollapsed, toggleAlbumGroupCollapsing } from '$lib/utils/album-utils';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Checkbox, Icon, menuManager, type ActionItem } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { flip } from 'svelte/animate';
  import { slide } from 'svelte/transition';

  type Props = {
    albums: AlbumResponseDto[];
    group?: AlbumGroup | undefined;
    showOwner?: boolean;
    showDateRange?: boolean;
    showItemCount?: boolean;
    selectionMode?: boolean;
    selectedAlbumIds?: string[];
    onAlbumSelect?: (albumId: string) => void;
  };

  const {
    albums,
    group = undefined,
    showOwner = false,
    showDateRange = false,
    showItemCount = false,
    selectionMode = false,
    selectedAlbumIds = [],
    onAlbumSelect,
  }: Props = $props();

  let isCollapsed = $derived(!!group && isAlbumGroupCollapsed($albumViewSettings, group.id));
  let iconRotation = $derived(isCollapsed ? 'rotate-0' : 'rotate-90');
  let contextMenuAnchor: HTMLDivElement | undefined = $state();

  const oncontextmenu = async (event: MouseEvent, items: ActionItem[]) => {
    event.preventDefault();
    contextMenuAnchor?.setAttribute('style', `left: ${event.x}px; top: ${event.y}px;`);
    await menuManager.show({
      target: contextMenuAnchor ?? (event.currentTarget as HTMLElement),
      items,
    });
  };
</script>

<Portal>
  <div bind:this={contextMenuAnchor} class="absolute"></div>
</Portal>

{#if group}
  <div class="grid">
    <button
      type="button"
      onclick={() => toggleAlbumGroupCollapsing(group.id)}
      class="mt-2 w-full cursor-pointer rounded-md py-2 pe-2 text-start transition-colors hover:bg-subtle hover:text-primary dark:text-immich-dark-fg dark:hover:bg-immich-dark-gray"
      aria-expanded={!isCollapsed}
    >
      <Icon icon={mdiChevronRight} size="24" class="-mt-2.5 inline-block transition-all duration-250 {iconRotation}" />
      <span class="text-3xl font-bold text-black dark:text-white">{group.name}</span>
      <span class="ms-1.5">({$t('albums_count', { values: { count: albums.length } })})</span>
    </button>
    <hr class="dark:border-immich-dark-gray" />
  </div>
{/if}

<div class="mt-4">
  {#if !isCollapsed}
    <div class="grid grid-auto-fill-56 gap-y-4" transition:slide={{ duration: 300 }}>
      {#each albums as album, index (album.id)}
        {@const { Edit, Share, Download, Leave, Delete } = getAlbumActions($t, album)}
        {@const items = [Edit, Share, Download, Leave, Delete]}
        <div class="relative h-fit" animate:flip={{ duration: 400 }}>
          {#if selectionMode && isAlbumEditor(album)}
            <div class="absolute top-7 left-7 z-10 rounded-md bg-white/90 p-1 dark:bg-immich-dark-gray/90">
              <Checkbox
                id="select-album-{album.id}"
                checked={selectedAlbumIds.includes(album.id)}
                aria-label={$t('select_album_named', { values: { album: album.albumName } })}
                onclick={(event) => event.stopPropagation()}
                onCheckedChange={() => onAlbumSelect?.(album.id)}
              />
            </div>
          {/if}
          <a
            href={Route.viewAlbum(album)}
            class="h-fit"
            onclick={(event) => {
              if (selectionMode && isAlbumEditor(album)) {
                event.preventDefault();
                onAlbumSelect?.(album.id);
              }
            }}
            oncontextmenu={(event) => oncontextmenu(event, items)}
          >
            <AlbumCard
              {album}
              {showOwner}
              {showDateRange}
              {showItemCount}
              preload={index < 20}
              contextMenuItems={items}
            />
          </a>
        </div>
      {/each}
    </div>
  {/if}
</div>
