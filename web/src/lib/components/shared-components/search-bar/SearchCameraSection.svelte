<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { getSearchSuggestions, SearchSuggestionType } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { MediaType } from '$lib/constants';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { cameraLabel, isCameraMake, isCameraModel, isCameraLens } from '$lib/utils/capture-devices';
  import SearchButton from './SearchButton.svelte';

  let filters = $derived(searchManager.filter.camera);
  let makes = $state<string[]>([]);
  let models = $state<string[]>([]);
  let lensModels = $state<string[]>([]);
  let make = $derived(filters.make || undefined);
  let model = $derived(filters.model || undefined);

  const strings = (values: Array<string | null>) => values.filter((value): value is string => Boolean(value?.trim()));
  const sorted = (values: string[]) =>
    [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  onMount(() =>
    handlePromiseError(
      (async () => {
        makes = sorted(
          strings(await getSearchSuggestions({ $type: SearchSuggestionType.CameraMake })).filter(isCameraMake),
        );
      })(),
    ),
  );

  // 切换面板或快速切换机身时，旧请求不覆盖新选择的候选项，也不清除 URL 恢复的筛选。
  $effect(() => {
    const selectedMake = make;
    let current = true;
    models = [];
    handlePromiseError(
      (async () => {
        const values = strings(
          await getSearchSuggestions({ $type: SearchSuggestionType.CameraModel, make: selectedMake }),
        );
        if (current) models = sorted(values.filter(isCameraModel));
      })(),
    );
    return () => {
      current = false;
    };
  });

  $effect(() => {
    const selectedMake = make;
    const selectedModel = model;
    let current = true;
    lensModels = [];
    handlePromiseError(
      (async () => {
        const values = strings(
          await getSearchSuggestions({
            $type: SearchSuggestionType.CameraLensModel,
            make: selectedMake,
            model: selectedModel,
          }),
        );
        if (current) lensModels = sorted(selectedMake || selectedModel ? values : values.filter(isCameraLens));
      })(),
    );
    return () => {
      current = false;
    };
  });

  function prepare() {
    searchManager.filter.deviceModels = undefined;
    searchManager.filter.mediaType = MediaType.Image;
    if (searchManager.filter.mediaCategory === 'phone-video') searchManager.filter.mediaCategory = undefined;
  }

  function selectMake(value?: string) {
    prepare();
    searchManager.filter.camera = { make: value };
  }

  function selectModel(value?: string) {
    prepare();
    searchManager.filter.camera = { make: filters.make, model: value };
  }

  function selectLens(value?: string) {
    prepare();
    filters.lensModel = value;
  }
</script>

<div id="camera-selection">
  <Text class="pb-5">{$t('camera_lens_description')}</Text>
  <fieldset>
    <Text class="pb-3">{$t('make')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={!make} onclick={() => selectMake()}>{$t('all')}</SearchButton>
      {#each makes as value (value)}
        <SearchButton checked active={make === value} onclick={() => selectMake(value)}>{value}</SearchButton>
      {/each}
    </div>
  </fieldset>
  <fieldset class="mt-5">
    <Text class="pb-3">{$t('model')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={!model} onclick={() => selectModel()}>{$t('all')}</SearchButton>
      {#each models as value (value)}
        <SearchButton checked active={model === value} onclick={() => selectModel(value)}
          >{cameraLabel(value)}</SearchButton
        >
      {/each}
    </div>
  </fieldset>
  <fieldset class="mt-5">
    <Text class="pb-3">{$t('lens_model')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={!filters.lensModel} onclick={() => selectLens()}>{$t('all')}</SearchButton>
      {#each lensModels as value (value)}
        <SearchButton checked active={filters.lensModel === value} onclick={() => selectLens(value)}
          >{value}</SearchButton
        >
      {/each}
    </div>
  </fieldset>
</div>
