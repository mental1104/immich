<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { downloadAsset, type AssetResponseDto } from '@immich/sdk';
  import { LoadingSpinner } from '@immich/ui';
  import { getX5InspFailureReason, type X5InspFallback } from './x5-insp';
  import { renderX5InspPanorama } from './x5-insp-renderer';

  type Props = {
    asset: AssetResponseDto;
    onFallback: (fallback: X5InspFallback) => void;
  };

  let { asset, onFallback }: Props = $props();

  let panoramaUrl = $state<string>();
  let Viewer = $state<typeof import('../PhotoSphereViewerAdapter.svelte').default>();

  // 每次资源变化都会递增序号，确保旧请求不能覆盖新照片的渲染结果。
  let requestGeneration = 0;
  let activeObjectUrl: string | undefined;

  /**
   * 下载并渲染指定的 INSP 资源；过期请求只释放临时资源，不更新 UI。
   *
   * @param assetId 当前需要展示的 Immich 资源 ID。
   * @param generation 本次请求的代数，必须仍等于 requestGeneration 才能提交结果。
   * 副作用：读取原始文件、使用浏览器 GPU 渲染并创建临时 Object URL；失败时请求父组件降级。
   */
  const initialize = async (assetId: string, generation: number): Promise<void> => {
    let objectUrl: string | undefined;
    try {
      const source = await downloadAsset({ ...authManager.params, id: assetId });
      if (generation !== requestGeneration) {
        return;
      }

      const preferredWidth = Math.max(4096, Math.round(window.innerWidth * window.devicePixelRatio * 2));
      const panorama = await renderX5InspPanorama(source, { preferredWidth });
      if (generation !== requestGeneration) {
        return;
      }

      objectUrl = URL.createObjectURL(panorama);
      const { default: viewer } = await import('../PhotoSphereViewerAdapter.svelte');

      // 资源已切换时不提交过期结果，并立即释放它刚创建的 URL。
      if (generation !== requestGeneration) {
        URL.revokeObjectURL(objectUrl);
        return;
      }

      if (activeObjectUrl) {
        URL.revokeObjectURL(activeObjectUrl);
      }
      activeObjectUrl = objectUrl;
      panoramaUrl = objectUrl;
      Viewer = viewer;
    } catch (error) {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      if (generation !== requestGeneration) {
        return;
      }

      console.info('X5 INSP client enhancement is unavailable; falling back to the default viewer.', error);
      onFallback({ assetId, reason: getX5InspFailureReason(error) });
    }
  };

  // Svelte 会在 asset.id 改变或组件卸载时执行清理，避免上一张照片残留。
  $effect(() => {
    const assetId = asset.id;
    const generation = ++requestGeneration;
    panoramaUrl = undefined;
    Viewer = undefined;
    void initialize(assetId, generation);

    return () => {
      if (generation === requestGeneration) {
        requestGeneration++;
      }
      if (activeObjectUrl) {
        URL.revokeObjectURL(activeObjectUrl);
        activeObjectUrl = undefined;
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
