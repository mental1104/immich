<script lang="ts">
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import JobsPanel from './QueuePanel.svelte';
  import QueueGraph from './QueueGraph.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { getQueuesActions } from '$lib/services/queue.service';
  import { type QueueResponseDto } from '@immich/sdk';
  import { CommandPaletteDefaultProvider, Container, type ActionItem } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  onMount(() => queueManager.listen());

  let queues = $derived<QueueResponseDto[]>(queueManager.queues);
  let view = $state<'graph' | 'list'>('graph');

  const { ResumePaused, CreateJob, ManageConcurrency } = $derived(getQueuesActions($t, queueManager.queues));
  const commands: ActionItem[] = $derived([CreateJob, ManageConcurrency]);

  const onQueueUpdate = (update: QueueResponseDto) => {
    queues = queues.map((queue) => {
      if (queue.name === update.name) {
        return update;
      }
      return queue;
    });
  };
</script>

<CommandPaletteDefaultProvider name={$t('admin.queues')} actions={commands} />

<OnEvents {onQueueUpdate} />

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]} actions={[ResumePaused, CreateJob, ManageConcurrency]}>
  <Container size="large" center>
    {#if queues}
      <div class="mt-5 flex gap-2" role="group" aria-label={$t('pipeline.view')}>
        <button
          type="button"
          aria-pressed={view === 'graph'}
          onclick={() => (view = 'graph')}
          class={`rounded-full px-4 py-2 text-sm ${view === 'graph' ? 'bg-immich-primary text-white' : 'bg-gray-100 dark:bg-gray-800'}`}
          >{$t('pipeline.graph_view')}</button
        >
        <button
          type="button"
          aria-pressed={view === 'list'}
          onclick={() => (view = 'list')}
          class={`rounded-full px-4 py-2 text-sm ${view === 'list' ? 'bg-immich-primary text-white' : 'bg-gray-100 dark:bg-gray-800'}`}
          >{$t('pipeline.list_view')}</button
        >
      </div>
      {#if view === 'graph'}
        <QueueGraph {queues} />
      {:else}
        <JobsPanel {queues} />
      {/if}
    {/if}
  </Container>
</AdminPageLayout>
