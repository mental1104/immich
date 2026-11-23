<script lang="ts">
  import AlbumCover from '#lib/components/album-page/AlbumCover.svelte';
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import { getShortDateRange } from '#lib/utils/date-time.ts';
  import { type AlbumResponseDto } from '@immich/sdk';
  import { ContextMenuButton, type MenuItems } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    album: AlbumResponseDto;
    showOwner?: boolean;
    showDateRange?: boolean;
    showItemCount?: boolean;
    preload?: boolean;
    contextMenuItems?: MenuItems;
    compact?: boolean;
    coversOnly?: boolean;
  };

  const {
    album,
    showOwner = false,
    showDateRange = false,
    showItemCount = false,
    preload = false,
    contextMenuItems,
    compact = false,
    coversOnly = false,
  }: Props = $props();

  const owner = $derived(album.albumUsers[0].user);
</script>

<div
  class="group relative overflow-hidden rounded-2xl border border-transparent hover:border-gray-200 hover:bg-gray-100 dark:hover:border-gray-800 dark:hover:bg-gray-900 {compact
    ? 'p-1'
    : 'p-5'}"
  data-testid="album-card"
>
  {#if contextMenuItems}
    <div
      id="icon-{album.id}"
      class="absolute inset-e-6 top-6 opacity-0 group-hover:opacity-100 focus-within:opacity-100"
      data-testid="context-button-parent"
    >
      <ContextMenuButton
        translations={{ open_menu: $t('show_album_options') }}
        position="top-left"
        variant="filled"
        class="icon-white-drop-shadow"
        items={contextMenuItems}
      />
    </div>
  {/if}

  <AlbumCover {album} {preload} class="transition-all duration-300 hover:shadow-lg" />

  <!-- 纯封面保留可访问名称，鼠标悬停和键盘聚焦均展示标题；触屏仍可由详情开关查看。 -->
  <div
    class={coversOnly
      ? 'pointer-events-none absolute inset-x-1 bottom-1 rounded-b-xl bg-linear-to-t from-black/80 to-transparent p-3 text-white opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100'
      : compact
        ? 'mt-2 px-1 pb-1'
        : 'mt-4'}
  >
    <p
      class="line-clamp-2 w-full font-semibold wrap-break-word {coversOnly
        ? 'text-sm text-white'
        : compact
          ? 'text-sm text-black dark:text-white'
          : 'text-lg/6 text-black group-hover:text-primary dark:text-white'}"
      data-testid="album-name"
      title={album.albumName}
    >
      {album.albumName}
    </p>

    {#if !coversOnly && showDateRange && album.startDate && album.endDate}
      <p class="flex text-sm capitalize dark:text-immich-dark-fg">
        {getShortDateRange(album.startDate, album.endDate)}
      </p>
    {/if}

    {#if !coversOnly}<span class="flex gap-2 text-sm dark:text-immich-dark-fg" data-testid="album-details">
        {#if showItemCount}
          <p>
            {$t('items_count', { values: { count: album.assetCount } })}
          </p>
        {/if}

        {#if (showOwner || album.shared) && showItemCount}
          <p>•</p>
        {/if}

        {#if showOwner}
          {#if owner.id === authManager.user.id}
            <p>{$t('owned')}</p>
          {:else}
            <p>
              {$t('shared_by_user', { values: { user: owner.name } })}
            </p>
          {/if}
        {:else if album.shared}
          <p>{$t('shared')}</p>
        {/if}
      </span>{/if}
  </div>
</div>
