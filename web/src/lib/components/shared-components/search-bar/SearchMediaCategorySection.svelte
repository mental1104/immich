<script lang="ts">
  import { MediaType } from '$lib/constants';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { mediaCategories, type MediaCategory } from '$lib/utils/media-categories';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import SearchButton from './SearchButton.svelte';

  function selectCategory(category: MediaCategory | undefined) {
    searchManager.filter.mediaCategory = category;
    if (category) {
      searchManager.filter.mediaType = category === 'phone-video' ? MediaType.Video : MediaType.Image;
    }
  }
</script>

<div id="media-category-selection">
  <fieldset>
    <Text class="pb-5">{$t('media_categories')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={!searchManager.filter.mediaCategory} onclick={() => selectCategory(undefined)}>
        {$t('all')}
      </SearchButton>
      {#each mediaCategories as category (category.id)}
        <SearchButton
          checked
          active={searchManager.filter.mediaCategory === category.id}
          onclick={() => selectCategory(category.id)}
        >
          {$t(category.title)}
        </SearchButton>
      {/each}
    </div>
    {#if searchManager.filter.mediaCategory}
      <p class="mt-3 text-sm text-neutral-500">
        {$t(mediaCategories.find((category) => category.id === searchManager.filter.mediaCategory)!.description)}
      </p>
    {/if}
  </fieldset>
</div>
