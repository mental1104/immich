<script lang="ts">
  import { MediaType } from '#lib/constants.ts';
  import { searchManager } from '#lib/managers/search-manager.svelte.ts';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import SearchButton from './SearchButton.svelte';

  let filteredMedia = $derived(searchManager.filter.mediaType);

  /** @param type 独立的照片/视频条件；保留其他条件，避免隐式删除登记项中的来源规则。 */
  function selectMedia(type: MediaType) {
    searchManager.filter.mediaType = type;
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
</div>
