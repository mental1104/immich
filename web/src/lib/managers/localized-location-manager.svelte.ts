import { getForkLocalizedNames } from '@immich/sdk';
import { fromStore } from 'svelte/store';
import { browser } from '$app/environment';
import { lang } from '$lib/stores/preferences.store';
import { LocalizedLocationIndex, type LocationContext, type LocationKind } from '$lib/utils/localized-location';

const language = fromStore(lang);

class LocalizedLocationManager {
  private index = $state.raw(new LocalizedLocationIndex([]));
  private loading?: Promise<void>;
  private loaded = false;

  async load() {
    if (!browser || this.loaded) {
      return;
    }

    this.loading ??= getForkLocalizedNames()
      .then((rows) => {
        this.index = new LocalizedLocationIndex(rows);
        this.loaded = rows.length > 0;
      })
      .catch(() => {
        // 离线辅助数据不可用时保留原始地名，下一次打开相关页面可重试。
      })
      .finally(() => (this.loading = undefined));
    return this.loading;
  }

  display(kind: LocationKind, name: string | null | undefined, context: LocationContext = {}) {
    return language.current.startsWith('zh') ? this.index.display(kind, name, context) : (name ?? '');
  }

  searchTerms(kind: LocationKind, name: string, context: LocationContext = {}) {
    return this.index.searchTerms(kind, name, context);
  }

  location(context: LocationContext) {
    return [
      this.display('city', context.city, context),
      this.display('state', context.state, context),
      this.display('country', context.country),
    ]
      .filter(Boolean)
      .join(', ');
  }
}

export const localizedLocationManager = new LocalizedLocationManager();
