<script lang="ts">
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import { Route } from '#lib/route.ts';
  import {
    photoEditFileUrl,
    photoEditGraph,
    photoEditRequest,
    photoEditUrl,
    type PhotoEditEditor,
    type PhotoEditHistogram,
    type PhotoEditOverview,
    type PhotoEditProject,
    type PhotoEditReport,
    type PhotoEditVersion,
  } from '#lib/services/photo-edit-advice.service.ts';
  import { getAssetMediaUrl } from '#lib/utils.ts';
  import { AssetMediaSize } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { page } from '$app/state';

  const software = { lightroom: 'Lightroom Mobile', snapseed: 'Snapseed', photomator: 'Photomator' } as const;
  let assetId = $derived(page.url.searchParams.get('assetId'));
  let overview = $state<PhotoEditOverview>();
  let project = $state<PhotoEditProject>();
  let selectedId = $state<string | null>(null);
  let selected = $derived(project?.versions.find((item) => item.id === selectedId));
  let parent = $derived(project?.versions.find((item) => item.id === selected?.parentId));
  let graph = $derived(photoEditGraph(project?.versions ?? []));
  let reportVersion = $derived(selected?.state === 'ready' ? selected.id : null);
  let loadedReport = $state<{ versionId: string; report: PhotoEditReport | null } | null>(null);
  let report = $derived(loadedReport?.versionId === reportVersion ? loadedReport.report : null);
  let annotatedPlan = $derived(
    report?.kind === 'codex' && report.plan.render.regions !== undefined ? report.plan.render : null,
  );
  let resultView = $state<'annotation' | 'preview'>('annotation');
  let showAnnotation = $derived(annotatedPlan !== null && resultView === 'annotation');
  let againstParent = $state(false);
  let busy = $state(false);
  let showUpload = $state(false);
  let confirmId = $state<string | null>(null);
  let editor = $state<PhotoEditEditor>('lightroom');
  let note = $state('');
  let file = $state<File>();
  let tab = $state<keyof typeof software>('lightroom');
  let error = $state('');
  let clock = $state(Date.now());
  const progressLabels = {
    queued: 'photo_edit_stage_queued',
    preparing: 'photo_edit_stage_preparing',
    analyzing: 'photo_edit_stage_analyzing',
    rendering: 'photo_edit_stage_rendering',
    saving: 'photo_edit_stage_saving',
  } as const;
  const control =
    'inline-flex items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800';
  const primary =
    'inline-flex items-center justify-center rounded-lg bg-immich-primary px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-immich-dark-primary dark:text-black';

  /** @param id URL 中指定的原片，空值表示工作台索引。@param signal 导航时取消旧请求。 */
  async function load(id: string | null, signal: AbortSignal) {
    try {
      const result = await photoEditRequest<PhotoEditOverview>(photoEditUrl(), { signal });
      if (signal.aborted) return;
      overview = result;
      if (result.enabled && id) {
        const history = await photoEditRequest<PhotoEditProject>(photoEditUrl(id), { signal });
        if (signal.aborted) return;
        project = history;
        selectedId = history.versions.at(-1)?.id ?? null;
      }
    } catch (error_) {
      if (!signal.aborted) error = error_ instanceof Error ? error_.message : $t('photo_edit_failed');
    }
  }

  /** @param id 当前原片。刷新后台进度，并在页面切换后忽略迟到响应。 */
  async function refresh(id: string) {
    const history = await photoEditRequest<PhotoEditProject>(photoEditUrl(id));
    if (assetId === id) project = history;
  }

  /** @param id 选择历史节点，null 表示原片。清除上一节点的提交和对比意图。 */
  function select(id: string | null) {
    selectedId = id;
    againstParent = false;
    resultView = 'annotation';
    confirmId = null;
  }

  /** @param action 后期生成、上传、重试或提交。上传使用当前选中的父节点。 */
  async function mutate(action: 'generate' | 'upload' | 'retry' | 'commit') {
    const id = assetId;
    if (!id || busy) return;
    const revisionId = selectedId;
    busy = true;
    error = '';
    try {
      let url = photoEditUrl(id);
      let body: FormData | undefined;
      if (action === 'generate') {
        url += '/generate';
      } else if (action === 'upload') {
        if (!file) return;
        body = new FormData();
        body.append('file', file);
        body.append('editor', editor);
        if (note.trim()) body.append('note', note.trim());
        if (revisionId) body.append('parentId', revisionId);
        url += '/versions';
      } else {
        if (!revisionId) return;
        url += `/versions/${revisionId}/${action}`;
      }
      const version = await photoEditRequest<PhotoEditVersion>(url, { method: 'POST', body });
      if (assetId !== id) return;
      await refresh(id);
      if (assetId !== id) return;
      select(version.id);
      if (action === 'upload') {
        showUpload = false;
        file = undefined;
        note = '';
      }
    } catch (error_) {
      if (assetId === id) error = error_ instanceof Error ? error_.message : $t('photo_edit_failed');
    } finally {
      busy = false;
    }
  }

  /** @param id 原片。@param versionId 报告所在节点。@param signal 停止已切换版本的读取。 */
  async function loadReport(id: string, versionId: string, signal: AbortSignal) {
    try {
      const detail = await photoEditRequest<{ report: PhotoEditReport | null }>(
        photoEditUrl(id) + '/versions/' + versionId,
        { signal },
      );
      if (!signal.aborted) loadedReport = { versionId, report: detail.report };
    } catch (error_) {
      if (!signal.aborted) error = error_ instanceof Error ? error_.message : $t('photo_edit_failed');
    }
  }

  /** @param version 历史节点。@returns 用于按钮和对比图的可读名称。 */
  function versionName(version: PhotoEditVersion) {
    return version.kind === 'codex'
      ? $t('photo_edit_codex_preview')
      : `${version.editor && version.editor !== 'other' ? software[version.editor] + ' · ' : ''}${version.filename}`;
  }

  /** @param value 图像亮度统计。@returns 低、中、高亮度分区的百分比。 */
  function tonalRange(value: PhotoEditHistogram) {
    return [value.darkPercent, value.middlePercent, value.brightPercent]
      .map((percent) => percent.toFixed(1) + '%')
      .join(' / ');
  }

  $effect(() => {
    const id = assetId;
    const controller = new AbortController();
    project = undefined;
    overview = undefined;
    error = '';
    select(null);
    showUpload = false;
    file = undefined;
    note = '';
    void load(id, controller.signal);
    return () => controller.abort();
  });

  $effect(() => {
    const id = assetId;
    const version = reportVersion;
    const controller = new AbortController();
    loadedReport = null;
    if (id && version) void loadReport(id, version, controller.signal);
    return () => controller.abort();
  });

  onMount(() => {
    // 有正在处理的版本时才轮询。服务器重启留下的待处理记录可手动重试。
    const timer = setInterval(() => {
      const id = assetId;
      if (!busy && id && project?.versions.some(({ analyzing }) => analyzing)) {
        clock = Date.now();
        void refresh(id).catch(() => {});
      }
    }, 1800);
    return () => clearInterval(timer);
  });
</script>

<UserPageLayout title={$t('photo_edit_advice')}>
  <div class="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
    {#if error}<p role="alert" class="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
        {error}
      </p>{/if}
    {#if !overview && !error}
      <p role="status">{$t('loading')}</p>
    {:else if overview && !overview.enabled}
      <p>{$t('photo_edit_disabled')}</p>
    {:else if !assetId && overview}
      {#if overview.projects.length === 0}
        <p>{$t('photo_edit_empty')}</p>
        <a href={Route.photos()} class="mt-2 inline-block text-immich-primary underline dark:text-immich-dark-primary"
          >{$t('photos')}</a
        >
      {:else}
        <ul
          class="divide-y divide-gray-200 rounded-xl border border-gray-200 dark:divide-gray-700 dark:border-gray-700"
        >
          {#each overview.projects as item (item.assetId)}
            <li>
              <a
                class="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-gray-100 dark:hover:bg-gray-800"
                href={Route.photoEditAdvice(item.assetId)}
              >
                <span class="font-medium">{item.assetName}</span><time
                  datetime={item.updatedAt}
                  class="text-sm text-gray-500">{new Date(item.updatedAt).toLocaleString()}</time
                >
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if project && assetId}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <a href={Route.photoEditAdvice()} class="text-sm text-immich-primary underline dark:text-immich-dark-primary"
            >{$t('photo_edit_projects')}</a
          >
          <h2 class="mt-1 text-xl font-semibold break-all">{project.assetName}</h2>
        </div>
        <div class="flex flex-wrap gap-2">
          <a class={control} href={Route.viewAsset({ id: assetId })}>{$t('photo_edit_open_original')}</a>
          <button
            class={control}
            type="button"
            disabled={busy || !overview?.analysisEnabled}
            onclick={() => mutate('generate')}>{$t('photo_edit_generate')}</button
          >
          <button class={primary} type="button" disabled={busy} onclick={() => (showUpload = !showUpload)}
            >{$t('photo_edit_upload')}</button
          >
        </div>
      </div>
      {#if !overview?.analysisEnabled}<p class="text-sm text-gray-500">{$t('photo_edit_analysis_disabled')}</p>{/if}
      {#if showUpload}
        <form
          class="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700"
          onsubmit={(event) => {
            event.preventDefault();
            void mutate('upload');
          }}
        >
          <label class="flex min-w-0 flex-col gap-1 text-sm">
            {$t('photo_edit_file')}
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.webp,.tif,.tiff,.heic"
              required
              onchange={(event) => (file = event.currentTarget.files?.[0])}
            />
          </label>
          <label class="flex flex-col gap-1 text-sm"
            >{$t('photo_edit_software')}
            <select
              class="rounded-md border border-gray-300 bg-transparent p-2 dark:border-gray-600"
              bind:value={editor}
            >
              {#each Object.entries(software) as [key, name] (key)}<option value={key}>{name}</option>{/each}
              <option value="other">{$t('photo_edit_other')}</option>
            </select>
          </label>
          <label class="flex flex-1 flex-col gap-1 text-sm"
            >{$t('photo_edit_note')}
            <input
              class="rounded-md border border-gray-300 bg-transparent p-2 dark:border-gray-600"
              bind:value={note}
              maxlength="200"
            />
          </label>
          <button class={primary} type="submit" disabled={busy || !file}>{$t('upload')}</button>
          <p class="w-full text-sm break-all text-gray-500">
            {$t('photo_edit_based_on', {
              values: { name: selected ? versionName(selected) : $t('photo_edit_original') },
            })}
          </p>
        </form>
      {/if}

      <div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(14rem,22rem)_minmax(0,1fr)]">
        <nav
          aria-label={$t('photo_edit_history')}
          class="min-w-0 self-start rounded-xl border border-gray-200 p-3 dark:border-gray-700"
        >
          <h3 class="mb-2 font-semibold">{$t('photo_edit_history')}</h3>
          <button
            type="button"
            class="block w-full rounded-lg p-2 text-start text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
            aria-pressed={selectedId === null}
            disabled={busy}
            onclick={() => select(null)}>● {$t('photo_edit_original')}</button
          >
          <ul class="max-h-136 overflow-auto">
            {#each graph as { version, depth, last } (version.id)}
              <li style:padding-inline-start={`${depth * 0.8}rem`}>
                <button
                  type="button"
                  aria-pressed={selectedId === version.id}
                  disabled={busy}
                  class="flex w-full items-baseline gap-2 rounded-lg p-2 text-start text-sm hover:bg-gray-100 aria-pressed:bg-gray-100 dark:hover:bg-gray-800 dark:aria-pressed:bg-gray-800"
                  onclick={() => select(version.id)}
                >
                  <span class="font-mono text-gray-500" aria-hidden="true">{last ? '└─' : '├─'}</span>
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-medium" title={versionName(version)}>{versionName(version)}</span>
                    {#if version.note}<span class="truncate text-xs text-gray-500" title={version.note}
                        >{version.note}</span
                      >{/if}
                    <time class="text-xs text-gray-500" datetime={version.createdAt}
                      >{new Date(version.createdAt).toLocaleString()}</time
                    >
                  </span>
                  {#if version.committedAt}<span
                      class="shrink-0 rounded-sm bg-emerald-100 px-1.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                      >{$t('photo_edit_committed')}</span
                    >{/if}
                </button>
              </li>
            {/each}
          </ul>
        </nav>

        <section class="min-w-0 space-y-4" aria-label={$t('photo_edit_compare')}>
          {#if parent && (parent.kind === 'upload' || parent.state === 'ready')}
            <div class="flex gap-2">
              <button
                class={control}
                aria-pressed={!againstParent}
                type="button"
                onclick={() => (againstParent = false)}>{$t('photo_edit_original')}</button
              >
              <button class={control} aria-pressed={againstParent} type="button" onclick={() => (againstParent = true)}
                >{$t('photo_edit_parent')}</button
              >
            </div>
          {/if}
          {#if annotatedPlan}
            <div class="flex flex-wrap gap-2" role="group" aria-label={$t('photo_edit_compare')}>
              <button
                class={showAnnotation ? primary : control}
                aria-pressed={showAnnotation}
                type="button"
                onclick={() => (resultView = 'annotation')}>{$t('photo_edit_annotation')}</button
              >
              <button
                class={showAnnotation ? control : primary}
                aria-pressed={!showAnnotation}
                type="button"
                onclick={() => (resultView = 'preview')}>{$t('photo_edit_final_image')}</button
              >
            </div>
          {/if}
          <div class={`grid gap-3 ${selected ? 'sm:grid-cols-2' : ''}`}>
            <figure class="overflow-hidden rounded-xl bg-gray-950 text-white">
              <img
                class="aspect-4/3 w-full object-contain"
                src={againstParent && parent
                  ? photoEditFileUrl(assetId, parent.id, 'preview')
                  : selected?.state === 'ready'
                    ? photoEditFileUrl(assetId, selected.id, 'original')
                    : getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Preview, edited: false })}
                alt={againstParent && parent ? versionName(parent) : $t('photo_edit_original')}
              />
              <figcaption class="px-3 py-2 text-sm">
                {againstParent && parent ? versionName(parent) : $t('photo_edit_original')}
              </figcaption>
            </figure>
            {#if selected}
              <figure class="overflow-hidden rounded-xl bg-gray-950 text-white">
                {#if selected.kind === 'upload' || selected.state === 'ready'}
                  <img
                    class="aspect-4/3 w-full object-contain"
                    src={photoEditFileUrl(assetId, selected.id, showAnnotation ? 'annotation' : 'preview')}
                    alt={annotatedPlan
                      ? $t(showAnnotation ? 'photo_edit_annotation' : 'photo_edit_final_image')
                      : versionName(selected)}
                  />
                {:else}
                  <div class="grid aspect-4/3 place-items-center p-4 text-sm text-gray-300">
                    {$t(
                      selected.progress
                        ? progressLabels[selected.progress.stage]
                        : selected.analyzing
                          ? 'photo_edit_analyzing'
                          : 'photo_edit_no_preview',
                    )}
                  </div>
                {/if}
                <figcaption class="px-3 py-2 text-sm break-all">
                  {annotatedPlan
                    ? $t(showAnnotation ? 'photo_edit_annotation' : 'photo_edit_final_image')
                    : versionName(selected)}
                </figcaption>
              </figure>
            {/if}
          </div>

          {#if selected}
            {#if showAnnotation && annotatedPlan}
              <div class="space-y-1 text-sm text-gray-600 dark:text-gray-300">
                {#if Object.values(annotatedPlan.crop).some((value) => value > 0)}
                  <p>{$t('photo_edit_crop_legend')}</p>
                {/if}
                {#if annotatedPlan.regions?.length}
                  <ol class="list-decimal space-y-1 pl-6">
                    {#each annotatedPlan.regions as region, index (index)}
                      <li>
                        {region.target} · {$t(region.kind === 'light' ? 'photo_edit_region_light' : 'photo_edit_mask')} ·
                        {region.exposure === 0
                          ? $t('photo_edit_region_manual')
                          : `${region.exposure > 0 ? '+' : ''}${region.exposure.toFixed(2)} EV`}
                      </li>
                    {/each}
                  </ol>
                {/if}
              </div>
            {/if}
            {#if selected.progress}
              <div class="space-y-2 rounded-xl border border-gray-200 p-3 text-sm dark:border-gray-700">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <p role="status" class="font-medium">{$t(progressLabels[selected.progress.stage])}</p>
                  <span class="text-gray-500 tabular-nums dark:text-gray-400"
                    >{$t('photo_edit_elapsed', {
                      values: { seconds: Math.max(0, Math.floor((clock - selected.progress.queuedAt) / 1000)) },
                    })}</span
                  >
                </div>
                {#if selected.progress.summary.trim()}
                  <h3 class="font-medium">{$t('photo_edit_reasoning_summary')}</h3>
                  <p class="max-h-48 overflow-auto wrap-break-word whitespace-pre-wrap">{selected.progress.summary}</p>
                {/if}
              </div>
            {/if}
            <div class="flex flex-wrap items-center gap-2">
              {#if annotatedPlan}
                <a class={control} href={photoEditFileUrl(assetId, selected.id, 'annotation')} download="annotation.png"
                  >{$t('photo_edit_download_annotation')}</a
                >
              {/if}
              {#if selected.kind === 'upload' || selected.state === 'ready'}
                <a class={control} href={photoEditFileUrl(assetId, selected.id, 'image')}
                  >{$t(annotatedPlan ? 'photo_edit_download_final' : 'photo_edit_download_image')}</a
                >
              {/if}
              {#if selected.state === 'ready'}
                <a class={control} href={photoEditFileUrl(assetId, selected.id, 'report')}
                  >{$t('photo_edit_download_report')}</a
                >
              {/if}
              {#if selected.analyzing && !selected.progress}
                <span role="status" class="text-sm text-gray-500">{$t('photo_edit_analyzing')}</span>
              {:else if !selected.analyzing && selected.state !== 'ready'}
                <span class="text-sm text-gray-500"
                  >{$t(selected.state === 'failed' ? 'photo_edit_failed' : 'photo_edit_waiting')}</span
                >
                <button
                  class={control}
                  type="button"
                  disabled={busy || !overview?.analysisEnabled}
                  onclick={() => mutate('retry')}>{$t('photo_edit_retry')}</button
                >
              {/if}
              {#if selected.committedAt}
                <a class={control} href={Route.viewAsset({ id: assetId })}>{$t('photo_edit_view_stack')}</a>
              {:else if selected.kind === 'upload'}
                <button class={primary} type="button" disabled={busy} onclick={() => (confirmId = selected?.id ?? null)}
                  >{$t('photo_edit_commit')}</button
                >
              {/if}
            </div>
            {#if confirmId === selected.id}
              <div class="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
                <span>{$t('photo_edit_confirm')}</span>
                <button class={primary} type="button" disabled={busy} onclick={() => mutate('commit')}
                  >{$t('confirm')}</button
                >
                <button class={control} type="button" disabled={busy} onclick={() => (confirmId = null)}
                  >{$t('cancel')}</button
                >
              </div>
            {/if}
          {/if}

          {#if report}
            <article class="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
              {#if report.kind === 'codex'}
                <h3 class="text-lg font-semibold">{report.plan.verdict} · {report.plan.score}/10</h3>
                <p>{report.plan.diagnosis}</p>
                <p class="font-medium">{report.plan.style}</p>
                <div class="flex flex-wrap gap-2" role="group" aria-label={$t('photo_edit_software')}>
                  {#each Object.keys(software) as key (key)}
                    {@const app = key as keyof typeof software}
                    <button class={control} type="button" aria-pressed={tab === app} onclick={() => (tab = app)}
                      >{software[app]}</button
                    >
                  {/each}
                </div>
                <ol class="list-decimal space-y-2 ps-5 text-sm">
                  {#each report.plan[tab] as step, index (index)}
                    <li>
                      <strong>{step.tool}</strong> · {step.change}<br /><span class="text-gray-500 dark:text-gray-400"
                        >{step.check}</span
                      >
                    </li>
                  {/each}
                </ol>
                <dl class="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt class="font-medium">{$t('photo_edit_mask')}</dt>
                    <dd>{report.plan.mask}</dd>
                  </div>
                  <div>
                    <dt class="font-medium">{$t('photo_edit_curve')}</dt>
                    <dd>{report.plan.curve}</dd>
                  </div>
                  <div>
                    <dt class="font-medium">{$t('photo_edit_recoverable')}</dt>
                    <dd>{report.plan.recoverable}</dd>
                  </div>
                  <div>
                    <dt class="font-medium">{$t('photo_edit_limits')}</dt>
                    <dd>{report.plan.limits}</dd>
                  </div>
                </dl>
                <p class="text-xs text-gray-500">
                  {$t(annotatedPlan ? 'photo_edit_final_limit' : 'photo_edit_preview_limit')}
                </p>
              {:else}
                <h3 class="text-lg font-semibold">{report.review.verdict}</h3>
                {#if report.review.improvements.length}
                  <h4 class="font-medium">{$t('photo_edit_improvements')}</h4>
                  <ul class="list-disc ps-5">
                    {#each report.review.improvements as item, index (index)}<li>{item}</li>{/each}
                  </ul>
                {/if}
                {#if report.review.regressions.length}
                  <h4 class="font-medium">{$t('photo_edit_regressions')}</h4>
                  <ul class="list-disc ps-5">
                    {#each report.review.regressions as item, index (index)}<li>{item}</li>{/each}
                  </ul>
                {/if}
                <h4 class="font-medium">{$t('photo_edit_next')}</h4>
                <p>{report.review.nextStep}</p>
              {/if}
              <details class="text-sm">
                <summary class="cursor-pointer font-medium">{$t('photo_edit_histogram')}</summary>
                <p>{$t('photo_edit_original')} ({report.source}) · {tonalRange(report.original)}</p>
                {#if report.kind === 'upload'}
                  <p>{$t('photo_edit_upload')} · {tonalRange(report.edited)}</p>
                  {#if report.parent}<p>{$t('photo_edit_parent')} · {tonalRange(report.parent)}</p>{/if}
                {/if}
              </details>
            </article>
          {/if}
        </section>
      </div>
    {/if}
  </div>
</UserPageLayout>
