<script lang="ts">
  import Portal from '#lib/elements/Portal.svelte';
  import { assetCacheManager } from '#lib/managers/AssetCacheManager.svelte.ts';
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import type { TimelineAsset } from '#lib/managers/timeline-manager/types.ts';
  import { getAssetContextMenuActions } from '#lib/services/asset-context-menu.service.ts';
  import { handleError } from '#lib/utils/handle-error.ts';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { menuManager } from '@immich/ui';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  /** 时间线的单张右键入口；album只表示当前相簿，不推断首页照片的其他相簿归属。 */
  interface Props {
    album?: AlbumResponseDto;
  }
  let { album }: Props = $props();
  let anchor: HTMLDivElement | undefined = $state();
  let pending: AbortController | undefined;

  // 离开页面或进入专用选择器后，尚未完成的读取不能再弹出旧照片菜单。
  onDestroy(() => pending?.abort());

  /**
  在鼠标位置打开当前单张的菜单，不触发缩略图点击、长按选择或相似组展开。
  @param event 当前缩略图的contextmenu事件；触摸长按保留原行为。
  @param asset 右键命中的单张时间线资产快照。
  @returns 菜单关闭或读取被取消时完成；读取失败显示现有错误提示。
  */
  export async function show(event: MouseEvent, asset: TimelineAsset): Promise<void> {
    if (
      !anchor ||
      !authManager.authenticated ||
      authManager.isSharedLink ||
      (event instanceof PointerEvent && event.pointerType === 'touch')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    pending?.abort();
    const request = new AbortController();
    pending = request;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX || rect.left;
    const y = event.clientY || rect.top;
    // 读取期间点别处、滚动或按Escape就取消展示，避免慢请求稍后重新打开菜单。
    const cancel = () => request.abort();
    document.addEventListener('pointerdown', cancel, { capture: true, signal: request.signal });
    // 只响应用户滚动手势；缩略图获得焦点导致的自动滚动不能取消这次右键。
    document.addEventListener('wheel', cancel, { capture: true, passive: true, signal: request.signal });
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') cancel();
      },
      { signal: request.signal },
    );
    try {
      const fullAsset = await assetCacheManager.getAsset({ id: asset.id });
      if (request.signal.aborted || !anchor.isConnected) return;
      const items = getAssetContextMenuActions($t, fullAsset, album);
      request.abort();
      if (items.length === 0) return;
      anchor.style.left = `${x}px`;
      anchor.style.top = `${y}px`;
      await menuManager.show({ target: anchor, items, 'aria-label': $t('actions') });
    } catch (error) {
      if (!request.signal.aborted) handleError(error, $t('error_retrieving_asset_information'));
    } finally {
      request.abort();
      if (pending === request) pending = undefined;
    }
  }
</script>

<Portal><div bind:this={anchor} class="pointer-events-none fixed size-0"></div></Portal>
