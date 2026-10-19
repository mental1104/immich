<script lang="ts">
  import SearchButton from './SearchButton.svelte';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  let filters = $derived(searchManager.filter.display);
</script>

<div id="display-options-selection">
  <fieldset>
    <Text class="py-5" fontWeight="medium">{$t('library')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={filters.isFavorite} onclick={() => (filters.isFavorite = !filters.isFavorite)}
        >{$t('favorites')}</SearchButton
      >
      <SearchButton checked active={filters.isArchive} onclick={() => (filters.isArchive = !filters.isArchive)}
        >{$t('archive')}</SearchButton
      >
    </div>
  </fieldset>
  <fieldset>
    <Text class="py-5" fontWeight="medium">{$t('albums')}</Text>
    <div class="flex flex-wrap gap-2">
      <SearchButton checked active={filters.albumStatus === 'all'} onclick={() => (filters.albumStatus = 'all')}
        >{$t('search_filter_display_option_all_albums')}</SearchButton
      >
      <SearchButton checked active={filters.albumStatus === 'in'} onclick={() => (filters.albumStatus = 'in')}
        >{$t('search_filter_display_option_in_album')}</SearchButton
      >
      <SearchButton checked active={filters.albumStatus === 'notIn'} onclick={() => (filters.albumStatus = 'notIn')}
        >{$t('search_filter_display_option_not_in_album')}</SearchButton
      >
    </div>
  </fieldset>
</div>
