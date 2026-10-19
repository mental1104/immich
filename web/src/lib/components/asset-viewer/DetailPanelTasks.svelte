<script lang="ts">
  import { AssetJobName, AssetTypeEnum, getAssetInfo, runAssetJobs, type AssetResponseDto } from '@immich/sdk';
  import { SvelteSet } from 'svelte/reactivity';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { handleError } from '$lib/utils/handle-error';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();
  let refreshedTaskStatuses = $state<AssetResponseDto['taskStatuses']>();
  const taskStatuses = $derived(refreshedTaskStatuses ?? asset.taskStatuses ?? []);
  const busyTasks = new SvelteSet<string>();
  let pollHandle: ReturnType<typeof setInterval> | undefined;

  const tasks = $derived([
    { name: 'metadata-extraction', action: AssetJobName.RefreshMetadata },
    { name: 'thumbnail-generation', action: AssetJobName.RegenerateThumbnail },
    ...(asset.type === AssetTypeEnum.Image ? [{ name: 'face-detection', action: AssetJobName.RefreshFaces }] : []),
    ...(asset.type === AssetTypeEnum.Video ? [{ name: 'video-encoding', action: AssetJobName.TranscodeVideo }] : []),
  ]);

  const taskLabel = (name: string) => {
    switch (name) {
      case 'metadata-extraction': {
        return $t('asset_task.metadata-extraction');
      }
      case 'thumbnail-generation': {
        return $t('asset_task.thumbnail-generation');
      }
      case 'face-detection': {
        return $t('asset_task.face-detection');
      }
      case 'video-encoding': {
        return $t('asset_task.video-encoding');
      }
      default: {
        return name;
      }
    }
  };

  const taskStatusLabel = (status?: string) => {
    switch (status) {
      case 'queued': {
        return $t('asset_task_status.queued');
      }
      case 'running': {
        return $t('asset_task_status.running');
      }
      case 'completed': {
        return $t('asset_task_status.completed');
      }
      case 'failed': {
        return $t('asset_task_status.failed');
      }
      case 'skipped': {
        return $t('asset_task_status.skipped');
      }
      default: {
        return $t('asset_task_status.not-run');
      }
    }
  };

  $effect(() => {
    const active = taskStatuses.some(({ status }) => status === 'queued' || status === 'running');
    if (active && !pollHandle) {
      pollHandle = setInterval(() => void refresh(), 3000);
    } else if (!active && pollHandle) {
      clearInterval(pollHandle);
      pollHandle = undefined;
    }
  });

  const refresh = async () => {
    try {
      const updated = await getAssetInfo({ id: asset.id });
      refreshedTaskStatuses = updated.taskStatuses ?? [];
    } catch (error) {
      handleError(error, 'Unable to refresh asset task status');
    }
  };

  const runTask = async (taskName: string, action: AssetJobName) => {
    busyTasks.add(taskName);
    try {
      await runAssetJobs({ assetJobsDto: { assetIds: [asset.id], name: action } });
      await refresh();
    } catch (error) {
      handleError(error, 'Unable to queue asset task');
    } finally {
      busyTasks.delete(taskName);
    }
  };

  onDestroy(() => {
    if (pollHandle) {
      clearInterval(pollHandle);
    }
  });
</script>

<section class="py-3" aria-label={$t('asset_processing_tasks')}>
  <h3 class="mb-2 text-sm font-semibold">{$t('asset_processing_tasks')}</h3>
  <ul class="space-y-2">
    {#each tasks as task (task.name)}
      {@const taskStatus = taskStatuses.find(({ taskName }) => taskName === task.name)}
      {@const status = taskStatus?.status ?? 'not-run'}
      <li class="border-immich-gray-200 dark:border-immich-dark-gray-200 rounded-sm border p-2">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="text-sm">{taskLabel(task.name)}</p>
            <p class="text-xs text-immich-fg/60 dark:text-immich-dark-fg/60">{taskStatusLabel(status)}</p>
          </div>
          <button
            type="button"
            class="rounded-sm bg-immich-primary px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busyTasks.has(task.name) || status === 'queued' || status === 'running'}
            onclick={() => runTask(task.name, task.action)}
          >
            {$t('run_task')}
          </button>
        </div>
        {#if taskStatus?.status === 'failed' && taskStatus.errorMessage}
          <p class="mt-1 text-xs wrap-break-word text-red-600 dark:text-red-400" title={taskStatus.errorMessage}>
            {taskStatus.errorMessage}
          </p>
        {/if}
      </li>
    {/each}
  </ul>
</section>
