<script lang="ts">
  import PhotoCopilotPanel from '#lib/components/asset-viewer/PhotoCopilotPanel.svelte';
  import { Route } from '#lib/route.ts';
  import { t } from 'svelte-i18n';

  /** 照片查看器的 AI 入口面板。聊天和后期工作台沿用各自的业务页面。 */
  interface Props {
    assetId: string;
    fileName: string;
    canOpenWorkbench: boolean;
    onClose: () => void;
  }

  let { assetId, fileName, canOpenWorkbench, onClose }: Props = $props();
  let chatOpen = $state(false);
  const entry =
    'flex min-h-9 items-center rounded-md border border-white/20 px-3 py-1.5 text-start font-medium hover:bg-white/10';
</script>

<aside class="photo-ai-panel" aria-label={$t('photo_ai')} data-testid="photo-ai-panel">
  <header class="flex items-center justify-between gap-3 px-4 pt-3">
    <h2 class="font-semibold">{$t('photo_ai')}</h2>
    <button class="{entry} justify-center" type="button" onclick={onClose} aria-label={$t('close')}>&#x2715;</button>
  </header>
  <p class="truncate px-4 text-sm text-gray-300" title={fileName}>{fileName}</p>
  <nav class="flex flex-wrap gap-2 border-b border-white/20 px-4 py-3" aria-label={$t('photo_ai')}>
    <button
      class={[entry, chatOpen && 'bg-white/10']}
      type="button"
      aria-expanded={chatOpen}
      onclick={() => (chatOpen = !chatOpen)}>{$t('photo_ai_copilot')}</button
    >
    {#if canOpenWorkbench}
      <a class={entry} href={Route.photoEditAdvice(assetId)}>{$t('photo_edit_advice')}</a>
    {/if}
  </nav>

  {#if chatOpen}
    <!-- 打开聊天时才建立会话。切图时保留入口选择，只重建当前照片的聊天。 -->
    {#key assetId}
      <PhotoCopilotPanel {assetId} />
    {/key}
  {/if}
</aside>

<style>
  .photo-ai-panel {
    position: absolute;
    inset-block: 64px 0;
    inset-inline-end: 0;
    z-index: 50;
    width: var(--photo-ai-panel-width);
    display: flex;
    flex-direction: column;
    border-inline-start: 1px solid #4b4d58;
    background: var(--color-immich-dark-bg, #16181e);
    color: #eceef6;
    box-shadow: -8px 0 24px #0005;
  }
</style>
