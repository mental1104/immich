<script lang="ts">
  import QueuePanel from './QueuePanel.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { asQueueItem } from '$lib/services/queue.service';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getPipelineAncestors,
    getPipelineState,
    pipelineEdges,
    pipelineNodes,
    PIPELINE_HEIGHT,
    PIPELINE_NODE_HEIGHT,
    PIPELINE_NODE_WIDTH,
    PIPELINE_WIDTH,
    type PipelineNode,
    type PipelineQueue,
    type PipelineState,
  } from '$lib/utils/asset-pipeline';
  import {
    AssetJobName,
    getAssetInfo,
    QueueName,
    runAssetJobs,
    type AssetResponseDto,
    type QueueResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { t, type Translations } from 'svelte-i18n';

  let { queues }: { queues: QueueResponseDto[] } = $props();
  let selected = $state<PipelineQueue>(QueueName.MetadataExtraction);
  let zoom = $state(0.75);
  let assetId = $state('');
  let asset = $state<AssetResponseDto>();
  let busy = $state(false);
  let traceError = $state('');
  let generation = 0;
  const selectedNode = $derived(pipelineNodes.find(({ queue }) => queue === selected)!);
  const selectedTask = $derived(asset?.taskStatuses?.find(({ taskName }) => taskName === selectedNode.taskName));
  const ancestors = $derived(getPipelineAncestors(selected));
  const recorded = $derived(
    asset?.taskStatuses?.filter(({ taskName }) => pipelineNodes.some((node) => node.taskName === taskName)) ?? [],
  );
  const completed = $derived(recorded.filter(({ status }) => status === 'completed').length);
  const isInsv = $derived(asset?.originalFileName.toLowerCase().endsWith('.insv') ?? false);
  const retryAction = $derived(
    selected === QueueName.MetadataExtraction
      ? AssetJobName.RefreshMetadata
      : selected === QueueName.ThumbnailGeneration
        ? AssetJobName.RegenerateThumbnail
        : selected === QueueName.FaceDetection
          ? AssetJobName.RefreshFaces
          : undefined,
  );

  const isDisabled = (name: QueueName) => {
    const features = featureFlagsManager.value;
    if (name === QueueName.SmartSearch) {
      return !features.smartSearch;
    }
    if (name === QueueName.DuplicateDetection) {
      return !features.duplicateDetection;
    }
    if (name === QueueName.Ocr) {
      return !features.ocr;
    }
    if (name === QueueName.Sidecar) {
      return !features.sidecar;
    }
    if (name === QueueName.FaceDetection || name === QueueName.FacialRecognition) {
      return !features.facialRecognition;
    }
    return false;
  };
  const stateFor = (node: PipelineNode) =>
    getPipelineState(
      node,
      queues.find(({ name }) => name === node.queue),
      asset,
      isDisabled(node.queue),
    );
  const stateKeys = {
    completed: 'asset_task_status.completed',
    queued: 'asset_task_status.queued',
    running: 'asset_task_status.running',
    failed: 'asset_task_status.failed',
    skipped: 'asset_task_status.skipped',
    unknown: 'pipeline.state.unknown',
    idle: 'pipeline.state.idle',
    paused: 'pipeline.state.paused',
    disabled: 'pipeline.state.disabled',
    present: 'pipeline.state.present',
  } as const satisfies Record<PipelineState, Translations>;
  const stateLabel = (state: PipelineState) => $t(stateKeys[state]);
  const stateClass = (state: PipelineState) => {
    if (state === 'running') {
      return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200';
    }
    if (state === 'completed' || state === 'present') {
      return 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200';
    }
    if (state === 'failed') {
      return 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200';
    }
    if (state === 'queued' || state === 'paused') {
      return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200';
    }
    return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300';
  };
  const edgePath = (from: QueueName, to: QueueName) => {
    const a = pipelineNodes.find((node) => node.queue === from)!;
    const b = pipelineNodes.find((node) => node.queue === to)!;
    const x = a.x + PIPELINE_NODE_WIDTH;
    const y = a.y + PIPELINE_NODE_HEIGHT / 2;
    const endY = b.y + PIPELINE_NODE_HEIGHT / 2;
    const bend = Math.max(16, (b.x - x) / 2);
    return `M ${x} ${y} C ${x + bend} ${y}, ${b.x - bend} ${endY}, ${b.x - 5} ${endY}`;
  };

  async function loadAsset(id: string, quiet = false) {
    id = id.trim();
    if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) {
      traceError = $t('pipeline.invalid_asset');
      return;
    }
    if (busy) {
      return;
    }
    const request = quiet ? generation : ++generation;
    if (!quiet) {
      asset = undefined;
      traceError = '';
    }
    busy = true;
    try {
      const result = await getAssetInfo({ id });
      if (request === generation) {
        asset = result;
        traceError = '';
      }
    } catch {
      if (request === generation) {
        traceError = $t('pipeline.asset_error');
      }
    } finally {
      if (request === generation) {
        busy = false;
      }
    }
  }
  function clearAsset() {
    generation++;
    asset = undefined;
    assetId = '';
    traceError = '';
    busy = false;
  }
  async function retryAsset() {
    if (!asset || !retryAction || busy) {
      return;
    }
    const id = asset.id;
    const request = ++generation;
    busy = true;
    try {
      await runAssetJobs({ assetJobsDto: { assetIds: [id], name: retryAction } });
      const result = await getAssetInfo({ id });
      if (request === generation) {
        asset = result;
        traceError = '';
      }
    } catch {
      if (request === generation) {
        traceError = $t('pipeline.retry_error');
      }
    } finally {
      if (request === generation) {
        busy = false;
      }
    }
  }
  $effect(() => {
    const id = asset?.id;
    if (!id) {
      return;
    }
    const timer = setInterval(() => {
      if (!busy) {
        void loadAsset(id, true);
      }
    }, 6000);
    return () => clearInterval(timer);
  });
</script>

<section class="mt-6 space-y-4" aria-label={$t('pipeline.title')}>
  <div class="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-immich-dark-gray">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-xl font-semibold">{$t('pipeline.title')}</h2>
        <p class="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-300">{$t('pipeline.description')}</p>
      </div>
      <span class="rounded-full bg-immich-primary/10 px-3 py-1 text-sm text-immich-primary"
        >{$t('pipeline.node_count', { values: { count: pipelineNodes.length } })}</span
      >
    </div>
    <form
      class="mt-4 flex flex-wrap items-center gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        void loadAsset(assetId);
      }}
    >
      <label class="sr-only" for="pipeline-asset-id">{$t('pipeline.asset_id')}</label>
      <input
        id="pipeline-asset-id"
        class="min-w-0 flex-1 rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-sm dark:border-gray-600"
        placeholder={$t('pipeline.asset_id')}
        bind:value={assetId}
      />
      <button
        type="submit"
        disabled={busy}
        class="rounded-lg bg-immich-primary px-4 py-2 text-sm text-white disabled:opacity-50"
        >{$t('pipeline.trace')}</button
      >
      {#if asset}
        <button
          type="button"
          onclick={clearAsset}
          class="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600"
          >{$t('pipeline.global')}</button
        >
      {/if}
    </form>
    {#if traceError}<p class="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{traceError}</p>{/if}
    {#if asset}
      <div class="mt-3 rounded-lg bg-immich-primary/5 p-3 text-sm" aria-live="polite">
        <p class="font-medium break-all">{asset.originalFileName}</p>
        <p class="mt-1 text-gray-600 dark:text-gray-300">
          {$t('pipeline.trace_summary', { values: { completed, recorded: recorded.length } })}
        </p>
        {#if isInsv}<p class="mt-1 text-amber-700 dark:text-amber-300">{$t('pipeline.insv')}</p>{/if}
      </div>
    {/if}
  </div>

  <div
    class="overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-immich-dark-bg"
  >
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 text-xs dark:border-gray-700"
    >
      <p>{$t(asset ? 'pipeline.asset_legend' : 'pipeline.global_legend')}</p>
      <div class="flex items-center gap-2">
        <span>{$t('pipeline.edge_legend')}</span>
        <button
          type="button"
          aria-label={$t('pipeline.zoom_out')}
          disabled={zoom <= 0.5}
          onclick={() => (zoom = Math.max(0.5, zoom - 0.1))}
          class="rounded-sm border px-2 py-1 disabled:opacity-40">−</button
        >
        <span class="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label={$t('pipeline.zoom_in')}
          disabled={zoom >= 1.25}
          onclick={() => (zoom = Math.min(1.25, zoom + 0.1))}
          class="rounded-sm border px-2 py-1 disabled:opacity-40">+</button
        >
      </div>
    </div>
    <p class="px-4 py-2 text-xs text-gray-600 dark:text-gray-300">{$t('pipeline.canvas_help')}</p>
    <div class="max-h-[650px] overflow-auto" role="region" aria-label={$t('pipeline.canvas')}>
      <div style={`width:${PIPELINE_WIDTH * zoom}px;height:${PIPELINE_HEIGHT * zoom}px`}>
        <div
          class="relative origin-top-left"
          style={`width:${PIPELINE_WIDTH}px;height:${PIPELINE_HEIGHT}px;transform:scale(${zoom})`}
        >
          <svg class="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
            <defs
              ><marker
                id="pipeline-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker
              ></defs
            >
            {#each pipelineEdges as edge (`${edge.from}-${edge.to}`)}
              <path
                d={edgePath(edge.from, edge.to)}
                fill="none"
                class={ancestors.has(edge.from) && ancestors.has(edge.to)
                  ? 'text-immich-primary'
                  : 'text-gray-400 dark:text-gray-600'}
                stroke="currentColor"
                stroke-width="2"
                stroke-dasharray={edge.conditional ? '5 5' : undefined}
                marker-end="url(#pipeline-arrow)"
              />
            {/each}
          </svg>
          {#each pipelineNodes as node (node.queue)}
            {@const queue = queues.find(({ name }) => name === node.queue)}
            {@const item = asQueueItem($t, { name: node.queue })}
            {@const state = stateFor(node)}
            <button
              type="button"
              aria-pressed={selected === node.queue}
              onclick={() => (selected = node.queue)}
              class={`absolute flex flex-col gap-2 rounded-xl border-2 bg-white p-3 text-start shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-immich-primary dark:bg-immich-dark-gray ${selected === node.queue ? 'border-immich-primary' : 'border-gray-200 hover:border-gray-400 dark:border-gray-700'}`}
              style={`left:${node.x}px;top:${node.y}px;width:${PIPELINE_NODE_WIDTH}px;height:${PIPELINE_NODE_HEIGHT}px`}
            >
              <span class="flex items-center gap-2 text-sm font-semibold"
                ><Icon icon={item.icon} size="18" /><span class="line-clamp-1"
                  >{node.queue === QueueName.Library ? $t('pipeline.ingest') : item.title}</span
                ></span
              >
              <span class={`w-fit rounded-full px-2 py-0.5 text-xs ${stateClass(state)}`}>{stateLabel(state)}</span>
              <span
                class="line-clamp-2 text-xs text-gray-600 dark:text-gray-300"
                title={$t(`pipeline.hint.${node.queue}`)}
              >
                {#if asset}{$t(`pipeline.hint.${node.queue}`)}
                {:else if node.queue === QueueName.MetadataExtraction && queue?.metadataProgress}
                  {$t('pipeline.metadata_count', {
                    values: {
                      completed: queue.metadataProgress.completed.toLocaleString($locale),
                      total: queue.metadataProgress.total.toLocaleString($locale),
                    },
                  })}
                {:else if queue}
                  {$t('pipeline.queue_count', {
                    values: {
                      active: queue.statistics.active,
                      waiting: queue.statistics.waiting + queue.statistics.paused + queue.statistics.delayed,
                    },
                  })}
                {:else}{$t('pipeline.state.unknown')}{/if}
              </span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>

  <div class="rounded-2xl border border-gray-200 p-5 dark:border-gray-700">
    <h3 class="font-semibold">{asQueueItem($t, { name: selected }).title}</h3>
    <p class="mt-2 text-sm text-gray-600 dark:text-gray-300">{$t(`pipeline.hint.${selected}`)}</p>
    {#if asset}
      <div class="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span class={`rounded-full px-2 py-1 ${stateClass(stateFor(selectedNode))}`}
          >{stateLabel(stateFor(selectedNode))}</span
        >
        {#if selectedTask}<span>{$t('pipeline.attempts', { values: { count: selectedTask.attempts } })}</span>{/if}
        {#if retryAction}
          <button
            type="button"
            disabled={busy ||
              selectedTask?.status === 'running' ||
              selectedTask?.status === 'queued' ||
              isDisabled(selected) ||
              (isInsv && selected === QueueName.MetadataExtraction)}
            onclick={() => void retryAsset()}
            class="rounded-lg border border-immich-primary px-3 py-1 text-immich-primary disabled:opacity-40"
            >{$t('pipeline.retry_asset')}</button
          >
        {/if}
      </div>
      {#if selectedTask?.errorMessage}<p class="mt-2 text-sm break-all text-red-600 dark:text-red-400">
          {selectedTask.errorMessage}
        </p>{/if}
    {/if}
    <p class="mt-4 text-xs font-medium text-gray-600 dark:text-gray-300">{$t('pipeline.global_controls')}</p>
    <QueuePanel {queues} only={[selected]} />
  </div>
</section>
