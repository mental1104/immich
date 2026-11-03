<script lang="ts">
  import type { IphoneBackupCommand, IphoneBackupProgress } from '$lib/services/iphone-backup.service';
  import { locale } from '$lib/stores/preferences.store';
  import { t } from 'svelte-i18n';

  /** 管理员选中匹配节点后的控制面；进度来自服务端，不推断手机是否完成本地关联。 */
  let {
    progress,
    busy,
    stale,
    oncommand,
  }: {
    progress: IphoneBackupProgress;
    busy: boolean;
    stale: boolean;
    oncommand: (command: IphoneBackupCommand) => void;
  } = $props();
</script>

<div class="space-y-4 rounded-2xl border border-gray-200 p-5 dark:border-gray-700" aria-live="polite">
  <h3 class="font-semibold">{$t('iphone_backup.title')}</h3>
  <p class="text-sm text-gray-600 dark:text-gray-300">{$t('iphone_backup.description')}</p>
  <p class="text-sm">
    {$t('iphone_backup.count', {
      values: {
        ready: progress.ready.toLocaleString($locale),
        total: progress.total.toLocaleString($locale),
        pending: progress.pending.toLocaleString($locale),
      },
    })}
    · {$t(`iphone_backup.state.${progress.state}`)}
  </p>
  {#if stale}<p class="text-sm text-red-600" role="alert">{$t('iphone_backup.stale')}</p>{/if}
  {#if progress.batch}
    <p class="text-sm text-gray-600 dark:text-gray-300">
      {$t('iphone_backup.batch', {
        values: { completed: progress.batch.completed, mib: Math.round(progress.batch.bytes / 1024 ** 2) },
      })}
      {#if progress.batch.reason}
        · {$t(`iphone_backup.reason.${progress.batch.reason}`)}{/if}
    </p>
    {#if progress.state === 'failed' && progress.batch.errorCode}
      <p class="text-sm text-red-600" role="alert">{progress.batch.errorCode} {progress.batch.currentAssetId ?? ''}</p>
    {/if}
  {/if}
  <div class="flex flex-wrap gap-3">
    <button
      type="button"
      class="rounded-lg bg-immich-primary px-4 py-2 text-sm text-white disabled:opacity-50"
      disabled={busy || stale || progress.pending === 0 || ['running', 'queued', 'failed'].includes(progress.state)}
      onclick={() => oncommand(progress.state === 'paused' ? 'resume' : 'start')}>{$t('iphone_backup.start')}</button
    >
    <button
      type="button"
      class="rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
      disabled={busy || stale || !['running', 'queued'].includes(progress.state)}
      onclick={() => oncommand('pause')}>{$t('iphone_backup.pause')}</button
    >
    {#if progress.state === 'failed'}
      <button
        type="button"
        class="rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
        disabled={busy || stale}
        onclick={() => oncommand('retry')}>{$t('iphone_backup.retry')}</button
      >
    {/if}
  </div>
  <p class="text-xs text-gray-600 dark:text-gray-300">{$t('iphone_backup.limits')}</p>
  <p class="text-sm text-amber-700 dark:text-amber-300">
    {$t(progress.uploadsEnabled ? 'iphone_backup.phone_check' : 'iphone_backup.uploads_paused')}
  </p>
</div>
