<script lang="ts">
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { resolutionPresets } from '$lib/utils/media-categories';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import SearchButton from './SearchButton.svelte';
</script>

<div id="resolution-selection">
  <fieldset>
    <Text class="pb-5">{$t('resolution')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton
        checked
        active={!searchManager.filter.resolution}
        onclick={() => (searchManager.filter.resolution = undefined)}
      >
        {$t('all')}
      </SearchButton>
      {#each resolutionPresets as preset (preset.value)}
        <SearchButton
          checked
          active={searchManager.filter.resolution === preset.value}
          onclick={() => (searchManager.filter.resolution = preset.value)}
        >
          {preset.label} · {preset.dimensions}
        </SearchButton>
      {/each}
    </div>
    <p class="mt-3 text-sm text-neutral-500">{$t('resolution_filter_description')}</p>
  </fieldset>
</div>
