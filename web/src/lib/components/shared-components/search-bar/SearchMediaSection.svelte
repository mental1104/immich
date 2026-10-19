<script lang="ts">
  import { MediaType } from '$lib/constants';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import SearchButton from './SearchButton.svelte';

  let filteredMedia = $derived(searchManager.filter.mediaType);

  function selectMedia(type: MediaType) {
    searchManager.filter.mediaType = type;
    const category = searchManager.filter.mediaCategory;
    if (
      (type === MediaType.Image && category === 'phone-video') ||
      (type === MediaType.Video && category === 'screenshot')
    ) {
      searchManager.filter.mediaCategory = undefined;
    }
  }

  function selectCategory(category: 'phone-video' | 'screenshot' | undefined) {
    searchManager.filter.mediaCategory = category;
    if (category) {
      searchManager.filter.mediaType = category === 'phone-video' ? MediaType.Video : MediaType.Image;
    }
  }
</script>

<div id="media-type-selection">
  <fieldset>
    <Text class="pb-5">{$t('media_type_description')}</Text>

    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={filteredMedia === MediaType.All} onclick={() => selectMedia(MediaType.All)}>
        {$t('all')}
      </SearchButton>
      <SearchButton checked active={filteredMedia === MediaType.Image} onclick={() => selectMedia(MediaType.Image)}>
        {$t('image')}
      </SearchButton>
      <SearchButton checked active={filteredMedia === MediaType.Video} onclick={() => selectMedia(MediaType.Video)}>
        {$t('video')}
      </SearchButton>
    </div>
  </fieldset>
  <fieldset class="mt-5">
    <Text class="pb-5">{$t('media_categories')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={!searchManager.filter.mediaCategory} onclick={() => selectCategory(undefined)}>
        {$t('all')}
      </SearchButton>
      <SearchButton
        checked
        active={searchManager.filter.mediaCategory === 'phone-video'}
        onclick={() => selectCategory('phone-video')}
      >
        {$t('phone_videos')}
      </SearchButton>
      <SearchButton
        checked
        active={searchManager.filter.mediaCategory === 'screenshot'}
        onclick={() => selectCategory('screenshot')}
      >
        {$t('screenshots')}
      </SearchButton>
    </div>
    {#if searchManager.filter.mediaCategory}
      <p class="mt-3 text-sm text-neutral-500">
        {$t(
          searchManager.filter.mediaCategory === 'phone-video' ? 'phone_videos_description' : 'screenshots_description',
        )}
      </p>
    {/if}
  </fieldset>
</div>
