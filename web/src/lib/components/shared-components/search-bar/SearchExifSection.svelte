<script lang="ts">
  import { searchManager } from '$lib/managers/search-manager.svelte';

  let exifField = $state<'iso' | 'fNumber' | 'exposureTime' | 'focalLength'>('iso');
  let exifOperator = $state<'gt' | 'gte' | 'lt' | 'lte' | 'eq'>('gt');
  let exifValue = $state('');
  let fieldSelect = $state<HTMLSelectElement>();

  const fields = [
    { value: 'iso', label: 'ISO' },
    { value: 'fNumber', label: '光圈（f/）' },
    { value: 'exposureTime', label: '快门速度' },
    { value: 'focalLength', label: '焦段（mm）' },
  ] as const;
  const operators = [
    { value: 'gt', label: '大于 (>)' },
    { value: 'gte', label: '大于等于 (≥)' },
    { value: 'lt', label: '小于 (<)' },
    { value: 'lte', label: '小于等于 (≤)' },
    { value: 'eq', label: '等于 (=)' },
  ] as const;
  const symbols = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' };
  const labels = { iso: 'ISO', fNumber: '光圈', exposureTime: '快门', focalLength: '焦段' };

  const parseValue = () => {
    const rawValue = exifValue.trim();
    if (!rawValue) return undefined;
    const rawParts = rawValue.split('/');
    if (rawParts.length > 2 || rawParts.some((part) => !part.trim())) return undefined;
    const parts = rawParts.map((part) => Number(part.trim()));
    const value = parts.length === 2 ? parts[0] / parts[1] : parts[0];
    return Number.isFinite(value) && value > 0 && !(parts.length === 2 && parts[1] === 0) ? value : undefined;
  }

  export function hasPendingCondition() {
    return parseValue() !== undefined;
  }

  export function clearPendingCondition() {
    exifValue = '';
  }

  export function addCondition() {
    const value = parseValue();
    if (value === undefined) return false;
    searchManager.addExifCondition({ field: exifField, operator: exifOperator, value });
    exifValue = '';
    fieldSelect?.focus();
    return true;
  };
</script>

<section aria-label="曝光与镜头条件">
  <p class="pb-4 text-sm text-immich-fg/65 dark:text-immich-dark-fg/65">
    曝光参数可以逐条添加；所有条件需同时满足。填好后点击面板底部的“添加条件”，最后再搜索。
  </p>

  {#if searchManager.filter.exifConditions.length > 0}
    <div class="mb-5 flex flex-wrap gap-2" aria-label="已添加的曝光与镜头条件">
      {#each searchManager.filter.exifConditions as condition, index (`${condition.field}-${condition.operator}-${condition.value}-${index}`)}
        <span
          class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1.5 text-xs text-primary dark:text-immich-dark-primary"
        >
          {condition.field === 'fNumber' ? '光圈 f/' : labels[condition.field]}
          {symbols[condition.operator]}
          {condition.value}{condition.field === 'focalLength' ? ' mm' : condition.field === 'exposureTime' ? ' 秒' : ''}
          <button
            type="button"
            class="ms-1 rounded-full hover:bg-primary/15"
            aria-label={`移除${labels[condition.field]}条件`}
            onclick={() => searchManager.removeExifCondition(index)}>×</button
          >
        </span>
      {/each}
    </div>
  {:else}
    <p class="mb-5 rounded-lg bg-immich-fg/5 px-3 py-2 text-sm text-immich-fg/60 dark:bg-immich-dark-fg/5 dark:text-immich-dark-fg/60">
      例如：焦段大于 85 mm、ISO 小于等于 400。
    </p>
  {/if}

  <div class="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_1.2fr_auto] sm:items-end">
    <label class="col-span-2 flex flex-col gap-1.5 text-sm sm:col-span-1">
      <span>参数</span>
      <select
        bind:this={fieldSelect}
        class="min-w-0 rounded-lg border border-immich-fg/20 bg-white px-3 py-2 dark:bg-immich-dark-bg"
        bind:value={exifField}
      >
        {#each fields as field (field.value)}
          <option value={field.value}>{field.label}</option>
        {/each}
      </select>
    </label>
    <label class="flex flex-col gap-1.5 text-sm">
      <span>比较方式</span>
      <select
        class="min-w-0 rounded-lg border border-immich-fg/20 bg-white px-3 py-2 dark:bg-immich-dark-bg"
        bind:value={exifOperator}
      >
        {#each operators as operator (operator.value)}
          <option value={operator.value}>{operator.label}</option>
        {/each}
      </select>
    </label>
    <label class="flex flex-col gap-1.5 text-sm">
      <span>{exifField === 'exposureTime' ? '快门速度' : '数值'}</span>
      <input
        class="min-w-0 rounded-lg border border-immich-fg/20 bg-white px-3 py-2 dark:bg-immich-dark-bg"
        type="text"
        inputmode="decimal"
        placeholder={
          exifField === 'exposureTime'
            ? '例如 1/30'
            : exifField === 'focalLength'
              ? '例如 85'
              : exifField === 'fNumber'
                ? '例如 2.8'
                : '例如 400'
        }
        bind:value={exifValue}
        onkeydown={(event) => event.key === 'Enter' && event.preventDefault()}
      />
    </label>
  </div>
</section>
