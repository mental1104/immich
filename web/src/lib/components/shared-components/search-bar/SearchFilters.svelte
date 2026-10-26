<script lang="ts">
  import SearchHistorySection from './SearchHistorySection.svelte';
  import { t } from 'svelte-i18n';
  import { fly } from 'svelte/transition';
  import { Button, Text } from '@immich/ui';
  import {
    mdiAccount,
    mdiCamera,
    mdiCellphone,
    mdiAspectRatio,
    mdiShapeOutline,
    mdiCalendarBlank,
    mdiChevronDown,
    mdiChevronUp,
    mdiImage,
    mdiMagnify,
    mdiMapMarker,
    mdiTagMultiple,
    mdiTune,
  } from '@mdi/js';
  import SearchLocationSection from './SearchLocationSection.svelte';
  import { getAllTags, type PersonResponseDto, type TagResponseDto } from '@immich/sdk';
  import SearchMediaSection from './SearchMediaSection.svelte';
  import SearchMediaCategorySection from './SearchMediaCategorySection.svelte';
  import SearchResolutionSection from './SearchResolutionSection.svelte';
  import SearchCameraSection from './SearchCameraSection.svelte';
  import SearchDeviceSection from './SearchDeviceSection.svelte';
  import { cameraLabel, selectedDeviceLabel } from '$lib/utils/capture-devices';
  import SearchDateSection from './SearchDateSection.svelte';
  import SearchPeopleSection from './SearchPeopleSection.svelte';
  import SearchTagsSection from './SearchTagsSection.svelte';
  import SearchTextSection from './SearchTextSection.svelte';
  import SearchDisplaySection from './SearchDisplaySection.svelte';
  import SearchRatingsSection from './SearchRatingsSection.svelte';
  import SearchExifSection from './SearchExifSection.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    getPeople,
    getSearchDatePreset,
    getSearchDateTitle,
    getSearchMediaTitle,
    getSearchPeopleTitle,
    getSearchPlacesTitle,
    getSearchTagsTitle,
    getSearchTypeTitle,
  } from './search-bar-utils';
  import { onMount } from 'svelte';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { mediaCategories, resolutionPresets } from '$lib/utils/media-categories';
  import SearchButton from './SearchButton.svelte';

  interface Props {
    id: string;
    isOpen?: boolean;
    onSelectSearchTerm: (searchTerm: string) => void;
    onClearSearchTerm: (searchTerm: string) => void;
    onClearAllSearchTerms: () => void;
    onActiveSelectionChange: (selectedId: string | undefined) => void;
    onSearch: () => void;
    onKeepOpen: () => void;
  }

  let {
    id,
    isOpen = false,
    onSelectSearchTerm,
    onClearSearchTerm,
    onClearAllSearchTerms,
    onActiveSelectionChange,
    onSearch,
    onKeepOpen,
  }: Props = $props();

  let searchHistory = $state<SearchHistorySection>();
  let searchExifSection = $state<ReturnType<typeof SearchExifSection>>();

  let activeFilter = $state('type');
  let showAdvanced = $state(false);
  let peoplePromise = $state<Promise<PersonResponseDto[]>>();
  let people = $state<PersonResponseDto[]>();
  let tagsPromise = $state<Promise<TagResponseDto[]>>();
  let tags = $state<TagResponseDto[]>();

  let typeTitle = $derived(getSearchTypeTitle(searchManager.filter.queryType));
  let peopleTitle = $state<string>();
  let dateTitle = $derived(
    getSearchDateTitle(
      getSearchDatePreset(searchManager.filter.date.takenAfter, searchManager.filter.date.takenBefore),
      searchManager.filter.date.takenAfter,
      searchManager.filter.date.takenBefore,
    ),
  );
  let placesTitle = $derived(
    getSearchPlacesTitle(
      searchManager.filter.location.city,
      searchManager.filter.location.state,
      searchManager.filter.location.country,
    ),
  );
  let tagsTitle = $state<string>();
  let selectedCategory = $derived(
    mediaCategories.find((category) => category.id === searchManager.filter.mediaCategory),
  );
  let mediaTitle = $derived(getSearchMediaTitle(searchManager.filter.mediaType));
  let categoryTitle = $derived(selectedCategory ? $t(selectedCategory.title) : undefined);
  let resolutionTitle = $derived(
    resolutionPresets.find((preset) => preset.value === searchManager.filter.resolution)?.label,
  );
  let canAddCondition = $derived(
    searchManager.hasPendingCondition() ||
      (activeFilter === 'exif' && (searchExifSection?.hasPendingCondition() ?? false)),
  );
  let exifTitle = $derived.by(() => {
    const conditions = searchManager.filter.exifConditions;
    if (conditions.length === 0) return undefined;
    const first = conditions[0];
    const label = { iso: 'ISO', fNumber: '光圈', exposureTime: '快门', focalLength: '焦段' }[first.field];
    const operator = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' }[first.operator];
    return `${label} ${operator} ${first.value}${conditions.length > 1 ? ` +${conditions.length - 1}` : ''}`;
  });

  let deviceTitle = $derived(selectedDeviceLabel(searchManager.filter.deviceModels));
  let cameraTitle = $derived(
    [
      searchManager.filter.camera.model
        ? cameraLabel(searchManager.filter.camera.model)
        : searchManager.filter.camera.make,
      searchManager.filter.camera.lensModel,
    ]
      .filter(Boolean)
      .join(' · ') || undefined,
  );

  let filters = [
    {
      name: 'type',
      icon: mdiMagnify,
      title: $t('search_type'),
      activeTitle: () => typeTitle,
    },
    {
      name: 'people',
      icon: mdiAccount,
      title: $t('people'),
      activeTitle: () => peopleTitle,
    },
    {
      name: 'date',
      icon: mdiCalendarBlank,
      title: $t('date'),
      activeTitle: () => dateTitle,
    },
    {
      name: 'places',
      icon: mdiMapMarker,
      title: $t('places'),
      activeTitle: () => placesTitle,
    },
    ...(authManager.authenticated && authManager.preferences.tags.enabled
      ? [
          {
            name: 'tags',
            icon: mdiTagMultiple,
            title: $t('tags'),
            activeTitle: () => tagsTitle,
          },
        ]
      : []),
    {
      name: 'media',
      icon: mdiImage,
      title: $t('media'),
      activeTitle: () => mediaTitle,
    },
    {
      name: 'device',
      icon: mdiCellphone,
      title: $t('capture_device'),
      activeTitle: () => deviceTitle,
    },
    {
      name: 'camera',
      icon: mdiCamera,
      title: $t('camera_lens'),
      activeTitle: () => cameraTitle,
    },
    {
      name: 'exif',
      icon: mdiTune,
      title: '曝光与镜头',
      activeTitle: () => exifTitle,
    },
    {
      name: 'mediaCategory',
      icon: mdiShapeOutline,
      title: $t('media_categories'),
      activeTitle: () => categoryTitle,
    },
    {
      name: 'resolution',
      icon: mdiAspectRatio,
      title: $t('resolution'),
      activeTitle: () => resolutionTitle,
    },
  ];

  const advancedFiltersSet = $derived(
    searchManager.filter.display.isArchive ||
      searchManager.filter.display.isFavorite ||
      searchManager.filter.display.albumStatus !== 'all' ||
      searchManager.filter.orientation ||
      searchManager.filter.rating,
  );

  const clear = () => {
    searchManager.reset();
    searchExifSection?.clearPendingCondition();
    peopleTitle = tagsTitle = undefined;
  };

  const addCondition = () => {
    if (activeFilter === 'exif' && searchExifSection?.hasPendingCondition()) {
      if (!searchExifSection.addCondition()) return;
    }

    const active = filters.find((item) => item.name === activeFilter);
    const label = active?.activeTitle() ?? (activeFilter === 'type' ? '筛选条件' : active?.title) ?? '筛选条件';
    searchManager.addCurrentCondition(label);
    onKeepOpen();
  };

  onMount(() => {
    if (searchManager.filter.personIds.size > 0 && !peoplePromise) {
      peoplePromise = getPeople(searchManager.filter.personIds);
      void peoplePromise.then((res) => (people = res));
    }

    if (searchManager.filter.tagIds?.size && !tagsPromise) {
      tagsPromise = getAllTags();
      void tagsPromise.then((res) => (tags = res));
    }
  });

  $effect(() => {
    if (people) {
      peopleTitle = getSearchPeopleTitle(people, searchManager.filter.personIds);
    }
  });

  $effect(() => {
    if (searchManager.filter.tagIds === null) {
      tagsTitle = $t('untagged');
    } else if (tags) {
      tagsTitle = getSearchTagsTitle(tags, searchManager.filter.tagIds);
    }
  });

  export function moveSelection(increment: 1 | -1) {
    if (searchHistory) {
      searchHistory.moveSelection(increment);
    }
  }

  export function clearSelection() {
    if (searchHistory) {
      searchHistory.clearSelection();
    }
  }

  export function selectActiveOption() {
    if (searchHistory) {
      searchHistory.selectActiveOption();
    }
  }
</script>

<div role="listbox" {id}>
  {#if isOpen}
    <div
      transition:fly={{ y: 25, duration: 250 }}
      class="absolute z-1 max-h-[80svh] w-full overflow-y-auto rounded-b-3xl bg-white shadow-[0_8px_20px_rgba(0,0,0,0.12)] transition-all dark:bg-immich-dark-gray dark:text-gray-300"
    >
      <SearchHistorySection
        bind:this={searchHistory}
        {onSelectSearchTerm}
        {onClearSearchTerm}
        {onClearAllSearchTerms}
        {onActiveSelectionChange}
      />
      <div class="px-5">
        <Text class="py-5" fontWeight="medium" aria-hidden={true}>{$t('filter_by')}</Text>
        {#if searchManager.addedConditions.length > 0}
          <div class="mb-4 flex flex-wrap items-center gap-2" aria-label="已添加的筛选条件">
            <span class="text-xs text-immich-fg/60 dark:text-immich-dark-fg/60">已添加条件</span>
            {#each searchManager.addedConditions as label, index (`${label}-${index}`)}
              <span
                class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1.5 text-xs text-primary dark:text-immich-dark-primary"
              >
                {label}
                <button
                  type="button"
                  class="ms-1 rounded-full hover:bg-primary/15"
                  aria-label={`移除${label}`}
                  onclick={() => searchManager.removeAddedCondition(index)}>×</button
                >
              </span>
            {/each}
          </div>
        {/if}
        <div class="flex flex-wrap gap-2">
          {#each filters as item (item.name)}
            <SearchButton
              active={activeFilter === item.name || Boolean(item.activeTitle())}
              leadingIcon={item.icon}
              class={activeFilter === item.name ? 'border-2' : undefined}
              onclick={() => (activeFilter = item.name)}
            >
              {item.activeTitle() ?? item.title}
            </SearchButton>
          {/each}
          <SearchButton
            checked
            active={searchManager.filter.isPanorama ?? false}
            onclick={() => (searchManager.filter.isPanorama = !searchManager.filter.isPanorama)}
          >
            {$t('panorama')}
          </SearchButton>
        </div>
      </div>
      {#if activeFilter}
        <div class="px-5 pt-5">
          {#if activeFilter === 'type'}
            <SearchTextSection />
          {:else if activeFilter === 'people'}
            <SearchPeopleSection bind:title={peopleTitle} parentPromise={peoplePromise} />
          {:else if activeFilter === 'date'}
            <SearchDateSection />
          {:else if activeFilter === 'places'}
            <SearchLocationSection />
          {:else if activeFilter === 'tags'}
            <SearchTagsSection bind:title={tagsTitle} parentPromise={tagsPromise} />
          {:else if activeFilter === 'media'}
            <SearchMediaSection />
          {:else if activeFilter === 'device'}
            <SearchDeviceSection />
          {:else if activeFilter === 'camera'}
            <SearchCameraSection />
          {:else if activeFilter === 'exif'}
            <SearchExifSection bind:this={searchExifSection} />
          {:else if activeFilter === 'mediaCategory'}
            <SearchMediaCategorySection />
          {:else if activeFilter === 'resolution'}
            <SearchResolutionSection />
          {/if}
        </div>
      {/if}
      <div
        class="grid transition-[grid-template-rows] duration-200 ease-in-out {showAdvanced
          ? 'grid-rows-[1fr]'
          : 'grid-rows-[0fr]'}"
        inert={!showAdvanced}
      >
        <div class="overflow-hidden">
          <div class="my-5 h-px w-full bg-light-200 dark:bg-dark-600"></div>
          <div class="px-5">
            {#if authManager.authenticated && authManager.preferences.ratings.enabled}
              <SearchRatingsSection />
            {/if}
            <SearchDisplaySection />
          </div>
        </div>
      </div>
      <div class="my-5 h-px w-full bg-light-200 dark:bg-dark-600"></div>
      <div class="flex flex-wrap gap-2 px-5 pb-5">
        <Button
          size="small"
          variant={advancedFiltersSet ? 'outline' : 'ghost'}
          leadingIcon={mdiTune}
          trailingIcon={showAdvanced ? mdiChevronUp : mdiChevronDown}
          onclick={() => (showAdvanced = !showAdvanced)}>{$t('advanced_filters')}</Button
        >
        <div class="flex-1"></div>
        <Button
          size="small"
          variant="outline"
          disabled={!canAddCondition}
          onclick={addCondition}>添加条件</Button
        >
        <div class="flex-1"></div>
        <Button
          size="small"
          shape="round"
          variant="outline"
          color="secondary"
          class="bg-transparent"
          onclick={() => clear()}>{$t('clear_all')}</Button
        >
        <Button size="small" shape="round" onclick={() => onSearch()}>{$t('search')}</Button>
      </div>
    </div>
  {/if}
</div>
