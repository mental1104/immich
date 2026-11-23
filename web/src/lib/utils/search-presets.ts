import { MediaType } from '#lib/constants.ts';
import type { SearchExifCondition, SearchFilter } from '#lib/types.ts';
import { mediaCategories, type MediaCategory } from '#lib/utils/media-categories.ts';
import type { MediaResolution } from '@immich/sdk';
import { DateTime } from 'luxon';
import type { MessageFormatter } from 'svelte-i18n';
import { SvelteSet } from 'svelte/reactivity';

/** 可持久化的原子条件；空值表示“无标签/无评分”，缺省表示不覆盖此项。 */
export interface SearchPresetConditions {
  query?: { value: string; type: SearchFilter['queryType'] };
  queryAssetId?: string;
  personIds?: string[];
  tagIds?: string[] | null;
  country?: string;
  state?: string;
  city?: string;
  make?: string;
  model?: string;
  lensModel?: string;
  deviceModels?: string[];
  takenAfter?: string;
  takenBefore?: string;
  isArchive?: true;
  isFavorite?: true;
  albumStatus?: 'in' | 'notIn';
  mediaType?: MediaType.Image | MediaType.Video;
  isPanorama?: true;
  mediaCategory?: MediaCategory;
  resolution?: MediaResolution;
  orientation?: SearchFilter['orientation'];
  rating?: number | null;
  exifConditions?: SearchExifCondition[];
}

/** 登记项里的一个可单独勾选或移除的条件，id按字段和运算符稳定识别。 */
export interface SearchConditionAtom {
  id: string;
  label: string;
  conditions: SearchPresetConditions;
}

/** @param filter 当前实际生效条件，不修改。@returns 没有Set/DateTime的独立快照；未选条件保持缺省。 */
export function captureSearchConditions(filter: SearchFilter): SearchPresetConditions {
  return {
    query: filter.query ? { value: filter.query, type: filter.queryType } : undefined,
    queryAssetId: filter.queryAssetId,
    personIds: filter.personIds.size > 0 ? [...filter.personIds] : undefined,
    tagIds: filter.tagIds === null ? null : filter.tagIds.size > 0 ? [...filter.tagIds] : undefined,
    ...filter.location,
    ...filter.camera,
    deviceModels: filter.deviceModels?.length ? [...filter.deviceModels] : undefined,
    takenAfter: filter.date.takenAfter?.toISODate() ?? undefined,
    takenBefore: filter.date.takenBefore?.toISODate() ?? undefined,
    isArchive: filter.display.isArchive ? true : undefined,
    isFavorite: filter.display.isFavorite ? true : undefined,
    albumStatus: filter.display.albumStatus === 'all' ? undefined : filter.display.albumStatus,
    mediaType: filter.mediaType === MediaType.All ? undefined : filter.mediaType,
    isPanorama: filter.isPanorama ? true : undefined,
    mediaCategory: filter.mediaCategory,
    resolution: filter.resolution,
    orientation: filter.orientation,
    rating: filter.rating,
    exifConditions:
      filter.exifConditions.length > 0 ? filter.exifConditions.map((condition) => ({ ...condition })) : undefined,
  };
}

/** @param conditions 登记项或当前快照。@param t 当前界面翻译。@returns 可逐项勾选的条件，数值范围上下界分别列出。 */
export function getSearchConditionAtoms(
  conditions: SearchPresetConditions,
  t: MessageFormatter,
): SearchConditionAtom[] {
  const labels: Record<Exclude<keyof SearchPresetConditions, 'exifConditions'>, string> = {
    query: t('search'),
    queryAssetId: t('search'),
    personIds: t('people'),
    tagIds: t('tags'),
    country: t('country'),
    state: t('state'),
    city: t('city'),
    make: t('camera'),
    model: t('camera'),
    lensModel: t('camera_lens'),
    deviceModels: t('capture_device'),
    takenAfter: `${t('date')} ≥`,
    takenBefore: `${t('date')} ≤`,
    isArchive: t('archive'),
    isFavorite: t('favorites'),
    albumStatus: t('albums'),
    mediaType: t('media'),
    isPanorama: t('panorama'),
    mediaCategory: t('media_categories'),
    resolution: t('resolution'),
    orientation: t('orientation'),
    rating: t('rating'),
  };
  const atoms: SearchConditionAtom[] = [];
  for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
    const value = conditions[key];
    if (value === undefined) continue;
    let detail: string;
    switch (key) {
      case 'query': {
        detail = conditions.query!.value;
        break;
      }
      case 'mediaCategory': {
        detail = t(mediaCategories.find((item) => item.id === value)!.title);
        break;
      }
      case 'mediaType': {
        detail = t(value === MediaType.Image ? 'photos' : 'videos');
        break;
      }
      default: {
        if (Array.isArray(value)) detail = key === 'deviceModels' ? value.join(', ') : String(value.length);
        else detail = value === true ? '' : value === null ? t('none') : String(value);
      }
    }
    atoms.push({ id: key, label: `${labels[key]}${detail ? ` · ${detail}` : ''}`, conditions: { [key]: value } });
  }
  for (const condition of conditions.exifConditions ?? []) {
    const { field, operator, value } = condition;
    atoms.push({
      id: `exif:${field}:${operator}`,
      label: `${t(({ iso: 'iso', fNumber: 'f_number', exposureTime: 'exposure_time', focalLength: 'focal_length' } as const)[field])} ${{ gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' }[operator]} ${value}`,
      conditions: { exifConditions: [{ ...condition }] },
    });
  }
  return atoms;
}

/** @param target 当前编辑状态，会按所含字段修改。@param conditions 已校验登记项。@returns 无；仅替换指定字段，其余条件及不同EXIF运算符保留。 */
export function applySearchConditions(target: SearchFilter, conditions: SearchPresetConditions): void {
  if (conditions.query) {
    target.query = conditions.query.value;
    target.queryType = conditions.query.type;
  }
  if (conditions.queryAssetId !== undefined) target.queryAssetId = conditions.queryAssetId;
  if (conditions.personIds) target.personIds = new SvelteSet(conditions.personIds);
  if (conditions.tagIds !== undefined)
    target.tagIds = conditions.tagIds === null ? null : new SvelteSet(conditions.tagIds);
  for (const key of ['country', 'state', 'city'] as const)
    if (conditions[key] !== undefined) target.location[key] = conditions[key];
  for (const key of ['make', 'model', 'lensModel'] as const)
    if (conditions[key] !== undefined) target.camera[key] = conditions[key];
  if (conditions.deviceModels) target.deviceModels = [...conditions.deviceModels];
  if (conditions.takenAfter) target.date.takenAfter = DateTime.fromISO(conditions.takenAfter);
  if (conditions.takenBefore) target.date.takenBefore = DateTime.fromISO(conditions.takenBefore);
  if (conditions.isArchive !== undefined) target.display.isArchive = conditions.isArchive;
  if (conditions.isFavorite !== undefined) target.display.isFavorite = conditions.isFavorite;
  if (conditions.albumStatus !== undefined) target.display.albumStatus = conditions.albumStatus;
  if (conditions.mediaType !== undefined) target.mediaType = conditions.mediaType;
  if (conditions.isPanorama !== undefined) target.isPanorama = conditions.isPanorama;
  if (conditions.mediaCategory !== undefined) target.mediaCategory = conditions.mediaCategory;
  if (conditions.resolution !== undefined) target.resolution = conditions.resolution;
  if (conditions.orientation !== undefined) target.orientation = conditions.orientation;
  if (conditions.rating !== undefined) target.rating = conditions.rating;
  for (const condition of conditions.exifConditions ?? []) {
    target.exifConditions = [
      ...target.exifConditions.filter(
        (existing) => existing.field !== condition.field || existing.operator !== condition.operator,
      ),
      { ...condition },
    ];
  }
}

/** @param atoms 被勾选的原子条件。@returns 可写入登记表的组合，保留多个EXIF上下界。 */
export function combineSearchConditions(atoms: readonly SearchConditionAtom[]): SearchPresetConditions {
  const combined: SearchPresetConditions = {};
  for (const { conditions } of atoms) {
    const previous = combined.exifConditions ?? [];
    Object.assign(combined, conditions);
    if (conditions.exifConditions) combined.exifConditions = [...previous, ...conditions.exifConditions];
  }
  return combined;
}

/** 内置项沿用既有来源识别规则，集中在登记弹框展示，不再占用原子筛选菜单。 */
export const builtInSearchPresets = mediaCategories.map((category) => ({
  id: `builtin:${category.id}`,
  title: category.title,
  description: category.description,
  conditions: {
    mediaCategory: category.id,
    mediaType: category.type === 'VIDEO' ? MediaType.Video : MediaType.Image,
  } satisfies SearchPresetConditions,
}));
