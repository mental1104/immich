<script lang="ts">
  import Combobox, { asComboboxOptions } from '$lib/components/shared-components/Combobox.svelte';
  import { localizedLocationManager } from '$lib/managers/localized-location-manager.svelte';
  import type { LocationKind } from '$lib/utils/localized-location';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { getSearchSuggestions, SearchSuggestionType } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let filters = $derived(searchManager.filter.location);
  let countries: string[] = $state([]);
  let states: string[] = $state([]);
  let cities: string[] = $state([]);

  function options(kind: LocationKind, values: string[]) {
    const context = { country: filters.country, state: filters.state };
    return asComboboxOptions(values).map((option) => ({
      ...option,
      id: option.value,
      label: option.value ? localizedLocationManager.display(kind, option.value, context) : option.label,
      searchTerms: localizedLocationManager.searchTerms(kind, option.value, context),
    }));
  }

  let countryOptions = $derived(options('country', countries));
  let stateOptions = $derived(options('state', states));
  let cityOptions = $derived(options('city', cities));

  async function updateCountries() {
    const results: Array<string | null> = await getSearchSuggestions({
      $type: SearchSuggestionType.Country,
      includeNull: true,
    });

    countries = results.map((result) => result ?? '');

    if (filters.country && !countries.includes(filters.country)) {
      filters.country = undefined;
    }
  }

  async function updateStates(country?: string) {
    const results: Array<string | null> = await getSearchSuggestions({
      $type: SearchSuggestionType.State,
      country,
      includeNull: true,
    });

    states = results.map((result) => result ?? '');

    if (filters.state && !states.includes(filters.state)) {
      filters.state = undefined;
    }
  }

  async function updateCities(country?: string, state?: string) {
    const results: Array<string | null> = await getSearchSuggestions({
      $type: SearchSuggestionType.City,
      country,
      state,
    });

    cities = results.map((result) => result ?? '');

    if (filters.city && !cities.includes(filters.city)) {
      filters.city = undefined;
    }
  }
  let countryFilter = $derived(filters.country);
  let stateFilter = $derived(filters.state);

  // TODO replace by async $derived, at the latest when it's in stable https://svelte.dev/docs/svelte/await-expressions
  $effect(() => handlePromiseError(updateStates(countryFilter)));
  $effect(() => handlePromiseError(updateCities(countryFilter, stateFilter)));

  onMount(() => {
    void localizedLocationManager.load();
    handlePromiseError(updateCountries());
  });
</script>

<div id="location-selection">
  <Text>{$t('search_filter_location_description')}</Text>

  <div class="mt-5 grid grid-auto-fit-40 gap-5">
    <div class="w-full">
      <Combobox
        label={$t('country')}
        onSelect={(option) => (filters.country = option?.value)}
        options={countryOptions}
        placeholder={$t('search_country')}
        selectedOption={countryOptions.find((option) => option.value === filters.country)}
      />
    </div>

    <div class="w-full">
      <Combobox
        label={$t('state')}
        onSelect={(option) => (filters.state = option?.value)}
        options={stateOptions}
        placeholder={$t('search_state')}
        selectedOption={stateOptions.find((option) => option.value === filters.state)}
      />
    </div>

    <div class="w-full">
      <Combobox
        label={$t('city')}
        onSelect={(option) => (filters.city = option?.value)}
        options={cityOptions}
        placeholder={$t('search_city')}
        selectedOption={cityOptions.find((option) => option.value === filters.city)}
      />
    </div>
  </div>
</div>
