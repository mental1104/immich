<script lang="ts">
  import { cleanClass } from '$lib';
  import { Icon, LoadingSpinner } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiPauseCircleOutline, mdiPlayCircleOutline } from '@mdi/js';
  import { Duration } from 'luxon';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetHlsSessionUrl, getAssetMediaUrl } from '$lib/utils';
  import { shouldPlaySmallVideoOriginal } from '$lib/utils/video-playback';
  import { AssetMediaSize, getAssetInfo } from '@immich/sdk';
  import 'hls-video-element';
  import type HlsVideoElement from 'hls-video-element';
  import Hls, { type HlsConfig } from 'hls.js';
  import type { ClassValue } from 'svelte/elements';

  interface Props {
    url: string;
    hlsUrl?: string;
    hlsAssetId?: string;
    knownFileSize?: number | null;
    durationInSeconds?: number;
    enablePlayback?: boolean;
    playbackOnIconHover?: boolean;
    showTime?: boolean;
    curve?: boolean;
    playIcon?: string;
    pauseIcon?: string;
    class?: ClassValue;
  }

  let {
    url,
    hlsUrl,
    hlsAssetId,
    knownFileSize,
    durationInSeconds = 0,
    enablePlayback = $bindable(false),
    playbackOnIconHover = false,
    showTime = true,
    curve = false,
    playIcon = mdiPlayCircleOutline,
    pauseIcon = mdiPauseCircleOutline,
    class: className,
  }: Props = $props();

  let remainingSeconds = $state(durationInSeconds);
  let loading = $state(true);
  let error = $state(false);
  let player: HTMLVideoElement | undefined = $state();
  let hlsPlayer: HlsVideoElement | undefined = $state();
  let hlsDecisionReady = $state(false);
  let useHlsPreview = $state(false);
  let directOriginalUrl = $state<string>();
  let activeSession: { assetId: string; id: string } | undefined;
  const sessionIdRegex = /\/video\/stream\/([0-9a-f-]{36})\//;
  const hlsConfig: Partial<HlsConfig> = {
    startLevel: 0,
    autoLevelCapping: 0,
    xhrSetup: (xhr, url) => {
      const authenticatedUrl = new URL(url, location.origin);
      for (const [key, value] of Object.entries(authManager.params)) {
        if (value) {
          authenticatedUrl.searchParams.set(key, value as string);
        }
      }
      xhr.open('GET', authenticatedUrl.href);
    },
  };

  const releaseSession = () => {
    const session = activeSession;
    activeSession = undefined;
    if (session) {
      void fetch(getAssetHlsSessionUrl(session.assetId, session.id), { method: 'DELETE' }).catch(() =>
        console.warn('Failed to release HLS thumbnail session', session),
      );
    }
  };

  $effect(() => {
    if (!enablePlayback || !hlsUrl || !hlsAssetId) {
      hlsDecisionReady = false;
      useHlsPreview = false;
      directOriginalUrl = undefined;
      return;
    }
    let cancelled = false;
    loading = true;
    error = false;
    hlsDecisionReady = false;
    const resolveFileSize =
      knownFileSize === undefined
        ? getAssetInfo({ id: hlsAssetId, ...authManager.params }).then((asset) => asset.exifInfo?.fileSizeInByte)
        : Promise.resolve(knownFileSize);
    void resolveFileSize
      .then((fileSize) => {
        if (cancelled) {
          return;
        }
        const smallOriginal = shouldPlaySmallVideoOriginal(fileSize, false);
        useHlsPreview = !smallOriginal;
        directOriginalUrl = smallOriginal
          ? getAssetMediaUrl({ id: hlsAssetId, size: AssetMediaSize.Original, edited: false })
          : undefined;
        hlsDecisionReady = true;
      })
      .catch(() => {
        if (!cancelled) {
          useHlsPreview = true;
          hlsDecisionReady = true;
        }
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (!enablePlayback || !hlsDecisionReady || !useHlsPreview || !hlsUrl || !hlsAssetId || !hlsPlayer) {
      return;
    }
    const element = hlsPlayer;
    element.config = hlsConfig;
    element.src = hlsUrl;
    queueMicrotask(() => {
      const api = element.api;
      if (!api) {
        return;
      }
      api.on(Hls.Events.MANIFEST_PARSED, () => {
        const id = api.levels[0]?.url[0]?.match(sessionIdRegex)?.[1];
        if (id) {
          activeSession = { assetId: hlsAssetId, id };
        }
      });
    });
    return () => {
      element.pause();
      element.removeAttribute('src');
      element.load();
      releaseSession();
    };
  });

  $effect(() => {
    if (!enablePlayback) {
      remainingSeconds = durationInSeconds;
      return;
    }
    if (!player) {
      return;
    }
    const video = player;
    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  });
  const onMouseEnter = () => {
    if (playbackOnIconHover) {
      enablePlayback = true;
    }
  };

  const onMouseLeave = () => {
    if (playbackOnIconHover) {
      enablePlayback = false;
    }
  };
</script>

{#if enablePlayback && hlsUrl && hlsDecisionReady && useHlsPreview}
  <hls-video
    bind:this={hlsPlayer}
    class={cleanClass('h-full w-full object-cover', className)}
    class:rounded-xl={curve}
    muted
    autoplay
    loop
    onplaying={() => {
      loading = false;
      error = false;
    }}
    onerror={() => {
      error = true;
      loading = false;
    }}
    ontimeupdate={({ currentTarget }) => {
      const video = currentTarget as HTMLVideoElement;
      const remaining = video.duration - video.currentTime;
      remainingSeconds = Math.min(Math.ceil(Number.isNaN(remaining) ? Infinity : remaining), durationInSeconds);
    }}
  ></hls-video>
{:else if enablePlayback && (!hlsUrl || (hlsDecisionReady && !useHlsPreview))}
  <video
    bind:this={player}
    class={cleanClass('h-full w-full object-cover', className)}
    class:rounded-xl={curve}
    muted
    autoplay
    loop
    src={directOriginalUrl ?? url}
    onplay={() => {
      loading = false;
      error = false;
    }}
    onerror={() => {
      if (directOriginalUrl && hlsUrl) {
        directOriginalUrl = undefined;
        useHlsPreview = true;
        return;
      }
      if (!player?.src) {
        // Do not show error when the URL is empty.
        return;
      }
      error = true;
      loading = false;
    }}
    ontimeupdate={({ currentTarget }) => {
      const remaining = currentTarget.duration - currentTarget.currentTime;
      remainingSeconds = Math.min(Math.ceil(Number.isNaN(remaining) ? Infinity : remaining), durationInSeconds);
    }}
  ></video>
{/if}

<div
  class="@container absolute inset-x-0 top-0 flex place-items-center justify-end gap-1 text-xs font-medium text-white text-shadow-[1px_1px_6px_rgb(0_0_0)]"
>
  {#if showTime}
    <span class="hidden pt-2 tabular-nums @min-[100px]:inline">
      {#if remainingSeconds < 60}
        {Duration.fromObject({ seconds: remainingSeconds }).toFormat('m:ss')}
      {:else if remainingSeconds < 3600}
        {Duration.fromObject({ seconds: remainingSeconds }).toFormat('mm:ss')}
      {:else}
        {Duration.fromObject({ seconds: remainingSeconds }).toFormat('h:mm:ss')}
      {/if}
    </span>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span
    class="pe-2 pt-2 drop-shadow-[1px_1px_6px_rgb(0_0_0)] @max-[99px]:scale-75 @max-[99px]:pe-1 @max-[99px]:pt-1"
    onmouseenter={onMouseEnter}
    onmouseleave={onMouseLeave}
  >
    {#if enablePlayback}
      {#if loading}
        <LoadingSpinner size="large" />
      {:else if error}
        <Icon icon={mdiAlertCircleOutline} size="24" class="text-red-600" />
      {:else}
        <Icon icon={pauseIcon} size="24" />
      {/if}
    {:else}
      <Icon icon={playIcon} size="24" />
    {/if}
  </span>
</div>
