<script lang="ts">
  import { requestPipelinePause, type PipelinePausePolicy } from '#lib/services/pipeline-pause.service.ts';
  import { QueueName } from '@immich/sdk';
  import { onMount } from 'svelte';

  let policy = $state<PipelinePausePolicy>();
  let stale = $state(false);
  let busy = $state(false);
  let selected = $state(QueueName.Ocr);

  /** @param maintenance 显式创建长期暂停；省略时只读取状态。 @returns 更新面板或标记读取失败，不隐藏旧状态。 */
  async function refresh(maintenance = false) {
    if (busy) {
      return;
    }
    busy = true;
    try {
      policy = await requestPipelinePause(maintenance ? { name: selected, mode: 'persistent' } : undefined);
      stale = false;
    } catch {
      stale = true;
    } finally {
      busy = false;
    }
  }

  /** 挂载时读取，五秒刷新；页面卸载后停止轮询。 */
  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  });
</script>

{#if policy?.enabled}
  <div class="my-4 rounded-xl bg-gray-100 p-4 text-sm dark:bg-gray-800" aria-live="polite">
    <p>
      Regular photo pipeline pauses resume automatically after {policy.durationMs / 60_000} minutes, including after a restart.
    </p>
    {#if stale}<p role="alert">Pause status is unavailable. Last known values are shown.</p>{/if}
    {#each policy.queues.filter((queue) => queue.isPaused) as queue (queue.name)}
      <p>
        {queue.name}: {queue.pause?.mode === 'persistent'
          ? 'Maintenance pause — resume manually'
          : queue.pause?.resumeAt
            ? `Resumes at ${new Date(queue.pause.resumeAt).toLocaleTimeString()}`
            : 'Awaiting pause deadline registration'}
      </p>
    {/each}
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <select class="rounded border p-2 dark:bg-gray-800" aria-label="Maintenance queue" bind:value={selected}>
        {#each policy.queues as queue (queue.name)}<option value={queue.name}>{queue.name}</option>{/each}
      </select>
      <button type="button" class="rounded border px-3 py-2" disabled={busy || stale} onclick={() => refresh(true)}
        >Pause until manually resumed (maintenance)</button
      >
    </div>
  </div>
{:else if stale}
  <p role="alert">Pause policy is unavailable.</p>
{/if}
