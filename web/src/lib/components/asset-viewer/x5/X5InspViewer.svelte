<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { AssetMediaSize, viewAsset, type AssetResponseDto } from '@immich/sdk';
  import { LoadingSpinner } from '@immich/ui';
  import { onMount } from 'svelte';
  import { getX5InspFailureReason, type X5InspFallback } from './x5-insp';
  import { renderX5InspPanorama } from './x5-insp-renderer';

  type Props = {
    asset: AssetResponseDto;
    onFallback: (fallback: X5InspFallback) => void;
  };

  let { asset, onFallback }: Props = $props();

  let panoramaUrl = $state<string>();
  let Viewer = $state<typeof import('../PhotoSphereViewerAdapter.svelte').default>();
  let disposed = false;

  /**
   * 下载原始 INSP，并在当前浏览器内生成临时全景预览。
   *
   * @param assetId 当前资源 ID；用于避免异步阶段读取到导航后的另一个资源。
   * @returns 初始化成功后更新组件状态；失败时调用一次 onFallback，不向服务端写入任何内容。
   */
  const initialize = async (assetId: string): Promise<void> => {
    let objectUrl: string | undefined;
    try {
      const source = await viewAsset({ ...authManager.params, id: assetId, size: AssetMediaSize.Original });
      const preferredWidth = Math.max(4096, Math.round(window.innerWidth * window.devicePixelRatio * 2));
      const panorama = await renderX5InspPanorama(source, { preferredWidth });
      objectUrl = URL.createObjectURL(panorama);
      const { default: viewer } = await import('../PhotoSphereViewerAdapter.svelte');

      // 用户可能在解码或渲染期间已切换资源；此时只释放临时 URL，不再更新已卸载的组件。
      if (disposed) {
        URL.revokeObjectURL(objectUrl);
        return;
      }

      panoramaUrl = objectUrl;
      Viewer = viewer;
    } catch (error) {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      console.info('X5 INSP client enhancement is unavailable; falling back to the default viewer.', error);
      if (!disposed) {
        onFallback({ assetId, reason: getX5InspFailureReason(error) });
      }
    }
  };

  onMount(() => {
    disposed = false;
    const assetId = asset.id;
    void initialize(assetId);

    return () => {
      disposed = true;
      if (panoramaUrl) {
        URL.revokeObjectURL(panoramaUrl);
      }
    };
  });
</script>

<div class="flex h-full place-content-center place-items-center select-none">
  {#if panoramaUrl && Viewer}
    <Viewer panorama={panoramaUrl} />
  {:else}
    <LoadingSpinner />
  {/if}
</div>
