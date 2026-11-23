import { MediaType, QueryType, validQueryTypes } from '#lib/constants.ts';
import { Route } from '#lib/route.ts';
import type { SearchExifCondition, SearchFilter } from '#lib/types.ts';
import { asLocalTimeISO, parseUtcDate } from '#lib/utils/date-time.ts';
import { mediaCategories } from '#lib/utils/media-categories.ts';
import {
  applySearchConditions,
  captureSearchConditions,
  combineSearchConditions,
  getSearchConditionAtoms,
  type SearchPresetConditions,
} from '#lib/utils/search-presets.ts';
import {
  AssetTypeEnum,
  AssetVisibility,
  Orientation,
  type SearchFilter as ApiSearchFilter,
  type MetadataSearchDto,
  type SmartSearchDto,
} from '@immich/sdk';
import type { DateTime } from 'luxon';
import { t } from 'svelte-i18n';
import { SvelteSet } from 'svelte/reactivity';
import { get } from 'svelte/store';
import { goto } from '$app/navigation';

const QUERY_TYPE_STORAGE_KEY = 'searchQueryType';
const orientations = { landscape: Orientation.Landscape, portrait: Orientation.Portrait };
type SearchQuery = MetadataSearchDto | SmartSearchDto;

/** 管理独立原子条件、登记项复用与URL转换；组合项展开为可单独移除的条件后仍走既有搜索入口。 */
class SearchManager {
  #filter = $state<SearchFilter>(this.#fromQuery({}));
  #addedConditions = $state<Array<{ id: string; label: string; filter: SearchFilter }>>([]);

  get filter() {
    return this.#filter;
  }

  get addedConditions() {
    return this.#addedConditions.map(({ label }) => label);
  }

  get effectiveFilter() {
    const effective = this.#fromQuery({});
    for (const { filter } of this.#addedConditions) {
      this.#mergeFilter(effective, filter);
    }
    this.#mergeFilter(effective, this.#filter);
    effective.query = this.#filter.query;
    effective.queryType = this.#filter.queryType;
    effective.queryAssetId = this.#filter.queryAssetId;
    effective.ocr = this.#filter.ocr;
    return effective;
  }

  reset() {
    this.#filter = this.#fromQuery({});
    this.#addedConditions = [];
  }

  setQuery(query: SearchQuery) {
    this.#filter = this.#fromQuery(query);
    this.#addedConditions = [];
  }

  hasPendingCondition() {
    const filter = this.#filter;
    return Boolean(
      filter.personIds.size > 0 ||
      filter.tagIds === null ||
      filter.tagIds?.size ||
      filter.location.city !== undefined ||
      filter.location.state !== undefined ||
      filter.location.country !== undefined ||
      filter.camera.make !== undefined ||
      filter.camera.model !== undefined ||
      filter.camera.lensModel !== undefined ||
      filter.deviceModels?.length ||
      filter.date.takenAfter ||
      filter.date.takenBefore ||
      filter.display.isArchive ||
      filter.display.isFavorite ||
      filter.display.albumStatus !== 'all' ||
      filter.mediaType !== MediaType.All ||
      filter.isPanorama ||
      filter.mediaCategory ||
      filter.resolution ||
      filter.orientation ||
      filter.rating !== undefined ||
      filter.exifConditions.length > 0,
    );
  }

  /** @param _ 保留旧调用签名；展示名改按各个原子字段生成。@returns 是否添加了条件，同字段/运算符替换旧值。 */
  addCurrentCondition(_: string) {
    if (!this.hasPendingCondition()) return false;
    const atoms = getSearchConditionAtoms(captureSearchConditions(this.#filter), get(t)).filter(
      (atom) => atom.id !== 'query' && atom.id !== 'queryAssetId',
    );
    const ids = new Set(atoms.map(({ id }) => id));
    this.#addedConditions = [
      ...this.#addedConditions.filter((condition) => !ids.has(condition.id)),
      ...atoms.map((atom) => {
        const filter = this.#fromQuery({});
        applySearchConditions(filter, atom.conditions);
        return { id: atom.id, label: atom.label, filter };
      }),
    ];
    const next = this.#fromQuery({});
    next.query = this.#filter.query;
    next.queryType = this.#filter.queryType;
    next.queryAssetId = this.#filter.queryAssetId;
    this.#filter = next;
    return true;
  }

  removeAddedCondition(index: number) {
    this.#addedConditions = this.#addedConditions.filter((_, conditionIndex) => conditionIndex !== index);
  }

  /** @returns 当前真正生效的原子条件，包含已添加条件和编辑中的条件。 */
  get conditionAtoms() {
    return getSearchConditionAtoms(captureSearchConditions(this.effectiveFilter), get(t));
  }

  /** @param conditions 登记项中的选定条件。@returns 无；先展平编辑状态，再只替换登记项覆盖的字段。 */
  applyPreset(conditions: SearchPresetConditions): void {
    const effective = this.effectiveFilter;
    applySearchConditions(effective, conditions);
    this.#addedConditions = [];
    this.#filter = effective;
  }

  /** @param id 要移除的原子字段/运算符。@returns 无；其他条件按原值恢复，避免一并清除整个组合。 */
  removeConditionAtom(id: string): void {
    const remaining = combineSearchConditions(this.conditionAtoms.filter((atom) => atom.id !== id));
    this.reset();
    applySearchConditions(this.#filter, remaining);
  }

  setQueryType(queryType: SearchFilter['queryType']) {
    this.#filter.queryType = queryType;
    localStorage.setItem(QUERY_TYPE_STORAGE_KEY, queryType);
  }

  addExifCondition(condition: SearchExifCondition) {
    this.#filter.exifConditions = [
      ...this.#filter.exifConditions.filter(
        (existing) => existing.field !== condition.field || existing.operator !== condition.operator,
      ),
      condition,
    ];
  }

  removeExifCondition(index: number) {
    this.#filter.exifConditions = this.#filter.exifConditions.filter((_, conditionIndex) => conditionIndex !== index);
  }

  async submit() {
    await goto(Route.search(this.#toQuery()));
  }

  #mergeFilter(target: SearchFilter, source: SearchFilter) {
    target.personIds = new SvelteSet([...target.personIds, ...source.personIds]);
    if (source.tagIds === null) {
      target.tagIds = null;
    } else if (source.tagIds.size > 0 && target.tagIds !== null) {
      target.tagIds = new SvelteSet([...target.tagIds, ...source.tagIds]);
    }
    target.location = {
      country: source.location.country === undefined ? target.location.country : source.location.country,
      state: source.location.state === undefined ? target.location.state : source.location.state,
      city: source.location.city === undefined ? target.location.city : source.location.city,
    };
    target.camera = {
      make: source.camera.make === undefined ? target.camera.make : source.camera.make,
      model: source.camera.model === undefined ? target.camera.model : source.camera.model,
      lensModel: source.camera.lensModel === undefined ? target.camera.lensModel : source.camera.lensModel,
    };
    target.deviceModels = source.deviceModels?.length ? source.deviceModels : target.deviceModels;
    target.date = {
      takenAfter: source.date.takenAfter || target.date.takenAfter,
      takenBefore: source.date.takenBefore || target.date.takenBefore,
    };
    target.display = {
      isArchive: target.display.isArchive || source.display.isArchive,
      isFavorite: target.display.isFavorite || source.display.isFavorite,
      albumStatus: source.display.albumStatus === 'all' ? target.display.albumStatus : source.display.albumStatus,
    };
    if (source.mediaType !== MediaType.All) target.mediaType = source.mediaType;
    target.isPanorama ||= source.isPanorama;
    target.mediaCategory = source.mediaCategory || target.mediaCategory;
    target.resolution = source.resolution || target.resolution;
    target.orientation = source.orientation || target.orientation;
    if (source.rating !== undefined) target.rating = source.rating;
    for (const condition of source.exifConditions) {
      target.exifConditions = [
        ...target.exifConditions.filter(
          (existing) => existing.field !== condition.field || existing.operator !== condition.operator,
        ),
        condition,
      ];
    }
  }

  /** 从 URL 搜索参数恢复面板状态；全景条件缺省时关闭，不修改输入参数。 */
  #fromQuery(searchQuery: MetadataSearchDto | SmartSearchDto): SearchFilter {
    // 含EXIF的请求使用结构化字段；刷新后也要还原其余原子条件，不能只恢复曝光值。
    const structured = searchQuery.filter;
    if (structured) {
      searchQuery = {
        ...searchQuery,
        originalFileName: structured.originalFileName?.like ?? structured.originalFileName?.eq,
        originalPath: structured.originalPath?.like ?? structured.originalPath?.eq,
        description: structured.description?.like ?? structured.description?.eq,
        ocr: structured.ocr?.matches,
        country: structured.country?.eq,
        state: structured.state?.eq,
        city: structured.city?.eq,
        make: structured.make?.eq,
        model: structured.model?.eq,
        lensModel: structured.lensModel?.eq,
        deviceModels: structured.model?.in ?? undefined,
        takenAfter: structured.takenAt?.gte,
        takenBefore: structured.takenAt?.lte,
        visibility: structured.visibility?.eq,
        type: structured.type?.eq,
        isFavorite: structured.isFavorite?.eq,
        isInAlbum: structured.hasAlbums?.eq === true || undefined,
        isNotInAlbum: structured.hasAlbums?.eq === false || undefined,
        personIds: structured.personIds?.any,
        tagIds: structured.hasTags?.eq === false ? null : structured.tagIds?.any,
        isPanorama: structured.isPanorama?.eq,
        isPhoneVideo: structured.isPhoneVideo?.eq,
        isScreenshot: structured.isScreenshot?.eq,
        isDeltaScreenshot: structured.isDeltaScreenshot?.eq,
        isSteamScreenshot: structured.isSteamScreenshot?.eq,
        isSwitchScreenshot: structured.isSwitchScreenshot?.eq,
        isNintendo3dsScreenshot: structured.isNintendo3dsScreenshot?.eq,
        resolution: structured.resolution?.eq,
        orientation: structured.orientation?.eq,
        rating: structured.rating?.eq,
      } as SearchQuery;
    }
    let query = 'query' in searchQuery && searchQuery.query ? searchQuery.query : '';
    let queryType = query ? QueryType.SMART : this.#defaultQueryType();

    if ('originalFileName' in searchQuery && searchQuery.originalFileName) {
      query = searchQuery.originalFileName;
      queryType = QueryType.METADATA;
    }

    if ('originalPath' in searchQuery && searchQuery.originalPath) {
      query = searchQuery.originalPath;
      queryType = QueryType.FULL_PATH;
    }

    if ('description' in searchQuery && searchQuery.description) {
      query = searchQuery.description;
      queryType = QueryType.DESCRIPTION;
    }

    if (searchQuery.ocr) {
      query = searchQuery.ocr;
      queryType = QueryType.OCR;
    }

    const exifConditions: SearchExifCondition[] = [];
    const numericFilters = searchQuery.filter as unknown as
      Record<string, Record<string, number> | undefined> | undefined;
    for (const field of ['iso', 'fNumber', 'exposureTime', 'focalLength'] as const) {
      const filter = numericFilters?.[field];
      if (!filter) continue;
      for (const operator of ['gt', 'gte', 'lt', 'lte', 'eq'] as const) {
        const value = filter[operator];
        if (value !== undefined) exifConditions.push({ field, operator, value });
      }
    }

    return {
      query,
      ocr: searchQuery.ocr,
      queryType,
      queryAssetId: 'queryAssetId' in searchQuery ? searchQuery.queryAssetId : undefined,
      personIds: new SvelteSet('personIds' in searchQuery ? searchQuery.personIds : []),
      tagIds:
        'tagIds' in searchQuery
          ? searchQuery.tagIds === null
            ? null
            : new SvelteSet(searchQuery.tagIds)
          : new SvelteSet(),
      location: {
        country: this.#withNullAsEmptyString(searchQuery.country),
        state: this.#withNullAsEmptyString(searchQuery.state),
        city: this.#withNullAsEmptyString(searchQuery.city),
      },
      deviceModels: searchQuery.deviceModels,
      camera: {
        make: this.#withNullAsEmptyString(searchQuery.make),
        model: this.#withNullAsEmptyString(searchQuery.model),
        lensModel: this.#withNullAsEmptyString(searchQuery.lensModel),
      },
      date: {
        takenAfter: searchQuery.takenAfter ? this.#toStartOfDayDate(searchQuery.takenAfter) : undefined,
        takenBefore: searchQuery.takenBefore ? this.#toStartOfDayDate(searchQuery.takenBefore) : undefined,
      },
      display: {
        isArchive: searchQuery.visibility === AssetVisibility.Archive,
        isFavorite: searchQuery.isFavorite ?? false,
        albumStatus:
          'isNotInAlbum' in searchQuery && searchQuery.isNotInAlbum
            ? 'notIn'
            : 'isInAlbum' in searchQuery && searchQuery.isInAlbum
              ? 'in'
              : 'all',
      },
      mediaType:
        searchQuery.type === AssetTypeEnum.Image
          ? MediaType.Image
          : searchQuery.type === AssetTypeEnum.Video
            ? MediaType.Video
            : MediaType.All,
      rating: searchQuery.rating,
      exifConditions,
      isPanorama: searchQuery.isPanorama ?? false,
      mediaCategory: mediaCategories.find((category) => searchQuery[category.flag])?.id,
      resolution: searchQuery.resolution,
      orientation: searchQuery.orientation,
    };
  }

  /** 生成现有搜索 API 参数；全景开关关闭时省略字段，保留原有请求语义。 */
  #toQuery(): SearchQuery {
    const filter = this.effectiveFilter;
    let type: AssetTypeEnum | undefined = undefined;
    if (filter.mediaType === MediaType.Image) {
      type = AssetTypeEnum.Image;
    } else if (filter.mediaType === MediaType.Video) {
      type = AssetTypeEnum.Video;
    }

    const query = filter.query || undefined;

    const exifFilter: ApiSearchFilter = {};
    for (const { field, operator, value } of filter.exifConditions) {
      const numericFilters = exifFilter as unknown as Record<string, Record<string, number>>;
      numericFilters[field] = { ...numericFilters[field], [operator]: value };
    }

    if (Object.keys(exifFilter).length > 0) {
      const structuredFilter = exifFilter as unknown as Record<string, unknown>;
      const addEquals = (field: string, value: unknown) => {
        if (value !== undefined) {
          structuredFilter[field] = { eq: value };
        }
      };

      for (const [field, value] of Object.entries({
        city: this.#emptyStringToNull(filter.location.city),
        state: this.#emptyStringToNull(filter.location.state),
        country: this.#emptyStringToNull(filter.location.country),
        make: this.#emptyStringToNull(filter.camera.make),
        model: this.#emptyStringToNull(filter.camera.model),
        lensModel: this.#emptyStringToNull(filter.camera.lensModel),
        type,
        rating: filter.rating,
        isFavorite: filter.display.isFavorite || undefined,
        hasAlbums: filter.display.albumStatus === 'all' ? undefined : filter.display.albumStatus === 'in',
        isPanorama: filter.isPanorama || undefined,
        isPhoneVideo: filter.mediaCategory === 'phone-video' || undefined,
        isScreenshot: filter.mediaCategory === 'screenshot' || undefined,
        isNintendo3dsScreenshot: filter.mediaCategory === '3ds-screenshot' || undefined,
        isSwitchScreenshot: filter.mediaCategory === 'switch-screenshot' || undefined,
        isSteamScreenshot: filter.mediaCategory === 'steam-screenshot' || undefined,
        isDeltaScreenshot: filter.mediaCategory === 'delta-screenshot' || undefined,
        resolution: filter.resolution,
        orientation: filter.orientation ? orientations[filter.orientation] : undefined,
        visibility: filter.display.isArchive ? AssetVisibility.Archive : undefined,
      })) {
        addEquals(field, value);
      }
      if (filter.deviceModels?.length) {
        structuredFilter.model = { ...(structuredFilter.model as object | undefined), in: [...filter.deviceModels] };
      }

      if (filter.date.takenAfter || filter.date.takenBefore) {
        structuredFilter.takenAt = {
          gte: filter.date.takenAfter
            ? asLocalTimeISO(filter.date.takenAfter.startOf('day') as DateTime<true>)
            : undefined,
          lte: filter.date.takenBefore
            ? asLocalTimeISO(filter.date.takenBefore.endOf('day') as DateTime<true>)
            : undefined,
        };
      }
      if (filter.personIds.size > 0) {
        structuredFilter.personIds = { any: [...filter.personIds] };
      }
      if (filter.tagIds === null) {
        structuredFilter.hasTags = { eq: false };
      } else if (filter.tagIds.size > 0) {
        structuredFilter.tagIds = { any: [...filter.tagIds] };
      }
      if (filter.queryType === 'ocr' && query) {
        structuredFilter.ocr = { matches: query };
      } else if (filter.queryType === 'metadata' && query) {
        structuredFilter.originalFileName = { like: query };
      } else if (filter.queryType === 'description' && query) {
        structuredFilter.description = { like: query };
      } else if (filter.queryType === 'fullPath' && query) {
        structuredFilter.originalPath = { like: query.trim() };
      }

      return {
        query: filter.queryType === 'smart' ? query : undefined,
        queryAssetId: filter.queryAssetId || undefined,
        filter: structuredFilter as ApiSearchFilter,
      } as SearchQuery;
    }

    return {
      query: filter.queryType === 'smart' ? query : undefined,
      queryAssetId: filter.queryAssetId || undefined,
      ocr: filter.queryType === 'ocr' ? query : undefined,
      originalFileName: filter.queryType === 'metadata' ? query : undefined,
      description: filter.queryType === 'description' ? query : undefined,
      originalPath: filter.queryType === 'fullPath' ? filter.query.trim() || undefined : undefined,
      country: this.#emptyStringToNull(filter.location.country),
      state: this.#emptyStringToNull(filter.location.state),
      city: this.#emptyStringToNull(filter.location.city),
      make: this.#emptyStringToNull(filter.camera.make),
      model: this.#emptyStringToNull(filter.camera.model),
      lensModel: this.#emptyStringToNull(filter.camera.lensModel),
      deviceModels: filter.deviceModels?.length ? filter.deviceModels : undefined,
      takenAfter: filter.date.takenAfter
        ? asLocalTimeISO(filter.date.takenAfter.startOf('day') as DateTime<true>)
        : undefined,
      takenBefore: filter.date.takenBefore
        ? asLocalTimeISO(filter.date.takenBefore.endOf('day') as DateTime<true>)
        : undefined,
      visibility: filter.display.isArchive ? AssetVisibility.Archive : undefined,
      isFavorite: filter.display.isFavorite || undefined,
      isNotInAlbum: filter.display.albumStatus === 'notIn' || undefined,
      isInAlbum: filter.display.albumStatus === 'in' || undefined,
      personIds: filter.personIds.size > 0 ? [...filter.personIds] : undefined,
      tagIds: filter.tagIds === null ? null : filter.tagIds.size > 0 ? [...filter.tagIds] : undefined,
      type,
      rating: filter.rating,
      isPanorama: filter.isPanorama || undefined,
      isPhoneVideo: filter.mediaCategory === 'phone-video' || undefined,
      isScreenshot: filter.mediaCategory === 'screenshot' || undefined,
      resolution: filter.resolution,
      isNintendo3dsScreenshot: filter.mediaCategory === '3ds-screenshot' || undefined,
      isSwitchScreenshot: filter.mediaCategory === 'switch-screenshot' || undefined,
      isSteamScreenshot: filter.mediaCategory === 'steam-screenshot' || undefined,
      isDeltaScreenshot: filter.mediaCategory === 'delta-screenshot' || undefined,
      orientation: filter.orientation ? orientations[filter.orientation] : undefined,
      filter: Object.keys(exifFilter).length > 0 ? exifFilter : undefined,
    };
  }

  #withNullAsEmptyString<T>(value: T | null) {
    return value === null ? '' : value;
  }

  #emptyStringToNull(value: string | undefined) {
    return value === '' ? null : value;
  }

  #toStartOfDayDate(dateString: string) {
    return parseUtcDate(dateString)?.startOf('day') || undefined;
  }

  #defaultQueryType(): QueryType {
    const storedQueryType = localStorage.getItem(QUERY_TYPE_STORAGE_KEY) as QueryType;
    return validQueryTypes.has(storedQueryType) ? storedQueryType : QueryType.SMART;
  }
}

export const searchManager = new SearchManager();
