<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Text } from '@immich/ui';
  import { getSearchSuggestions, SearchSuggestionType } from '@immich/sdk';
  import { MediaType } from '$lib/constants';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { deviceOptions } from '$lib/utils/capture-devices';
  import SearchButton from './SearchButton.svelte';

  let models = $state<string[]>([]);
  let loading = $state(true);
  let options = $derived(deviceOptions(models));
  const groups = [
    { id: 'iphone', title: 'iPhone' },
    { id: 'action', title: 'DJI / Insta360' },
    { id: 'other', title: undefined },
  ] as const;

  async function load() {
    try {
      const values = await getSearchSuggestions({ $type: SearchSuggestionType.CameraModel });
      models = values.filter((value): value is string => Boolean(value));
    } finally {
      loading = false;
    }
  }

  function select(models?: string[]) {
    searchManager.filter.deviceModels = models;
    if (models) {
      searchManager.filter.camera = {};
      searchManager.filter.mediaType = MediaType.Image;
      if (searchManager.filter.mediaCategory === 'phone-video') {
        searchManager.filter.mediaCategory = undefined;
      }
    }
  }

  onMount(() => handlePromiseError(load()));
</script>

<div id="device-selection" aria-busy={loading}>
  <Text class="pb-5">{$t('capture_device_description')}</Text>
  <SearchButton checked active={!searchManager.filter.deviceModels?.length} onclick={() => select()}
    >{$t('all')}</SearchButton
  >
  {#each groups as group (group.id)}
    {@const items = options.filter((option) => option.group === group.id)}
    {#if items.length}
      <fieldset class="mt-5">
        <Text class="pb-3">{group.title ?? $t('other_capture_devices')}</Text>
        <div class="flex flex-wrap gap-2">
          {#each items as option (option.label)}
            <SearchButton
              checked
              active={Boolean(searchManager.filter.deviceModels?.length) &&
                searchManager.filter.deviceModels?.length === option.models.length &&
                option.models.every((model) => searchManager.filter.deviceModels?.includes(model))}
              onclick={() => select(option.models)}
            >
              {option.label}
            </SearchButton>
          {/each}
        </div>
      </fieldset>
    {/if}
  {/each}
</div>
