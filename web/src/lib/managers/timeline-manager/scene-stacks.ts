import { querySceneStacks, type SceneStackGroup } from '#lib/queries/scene-stack.query.ts';
import { updateGeometry } from '#lib/managers/timeline-manager/internal/layout-support.svelte.ts';
import type { TimelineManager } from './timeline-manager.svelte.ts';
import type { TimelineMonth } from './timeline-month.svelte.ts';
import type { TimelineAsset } from './types.ts';
import type { TimeBucketAssetResponseDto } from '@immich/sdk';

/** @param bucket 原生按列编码的桶。@param ids 保留的行ID。@returns 同步筛选全部列，保留null列与原生stack数据。 */
export function selectSceneRows(
  bucket: TimeBucketAssetResponseDto,
  ids: ReadonlySet<string>,
): TimeBucketAssetResponseDto {
  const indices = bucket.id.flatMap((id, index) => (ids.has(id) ? [index] : []));
  // 时间桶合同的每个非空字段都是与id对齐的数组；整行投影后恢复原合同类型。
  return Object.fromEntries(
    Object.entries(bucket).map(([key, column]) => [
      key,
      Array.isArray(column) ? indices.map((index) => column[index]) : column,
    ]),
  ) as TimeBucketAssetResponseDto;
}

/** 一个桶的原始DTO和完整分组；弱引用确保桶卸载后不会长期留住照片数据。 */
interface LoadedScenes {
  source: TimeBucketAssetResponseDto;
  groups: SceneStackGroup[];
  expanded: Set<string>;
}

/** 仅管理外层显示，展开从原始桶恢复照片，不调用原生unstack或读取原生隐藏成员。 */
export class SceneStackSupport {
  private loaded = new WeakMap<TimelineMonth, LoadedScenes>();

  /** @param manager 所属时间线，负责资产容器和几何更新。 */
  constructor(private manager: TimelineManager) {}

  /** @returns 无返回值；切换显示或重新查询时丢弃旧桶的外层状态。 */
  reset(): void {
    this.loaded = new WeakMap();
  }

  /** @param month 原生月份。@param source 完整原生桶。@param signal 取消信号。@returns 折叠后的DTO，故障时返回完整桶。 */
  async prepare(
    month: TimelineMonth,
    source: TimeBucketAssetResponseDto,
    signal: AbortSignal,
  ): Promise<TimeBucketAssetResponseDto> {
    let groups: SceneStackGroup[];
    try {
      groups = await querySceneStacks(source.id, signal);
    } catch {
      return source;
    }
    if (signal.aborted) {
      return source;
    }
    const present = new Set(source.id);
    const used = new Set<string>();
    // 再次拒绝不完整、重叠的组，服务端升级或故障也不能造成照片从界面消失。
    groups = groups.filter((group) => {
      if (
        group.members.length < 2 ||
        !group.members.includes(group.coverId) ||
        new Set(group.members).size !== group.members.length ||
        group.members.some((id) => !present.has(id) || used.has(id))
      ) {
        return false;
      }
      group.members.forEach((id) => used.add(id));
      return true;
    });
    this.loaded.set(month, { source, groups, expanded: new Set() });
    const hidden = new Set(groups.flatMap((group) => group.members.filter((id) => id !== group.coverId)));
    return selectSceneRows(source, new Set(source.id.filter((id) => !hidden.has(id))));
  }

  /** @param month 已插入筛选DTO的月份。@returns 无返回值，仅为分组封面附加独立徽标。 */
  decorate(month: TimelineMonth): void {
    const scenes = this.loaded.get(month);
    if (!scenes) {
      return;
    }
    const groups = new Map(scenes.groups.map((group) => [group.coverId, group]));
    for (const asset of month.getAssets()) {
      const group = groups.get(asset.id);
      asset.sceneStack = group ? { count: group.members.length, expanded: scenes.expanded.has(group.id) } : undefined;
    }
  }

  /** @param cover 被点击的分组封面。@returns 是否处理了外层切换；普通照片返回false。 */
  toggle(cover: TimelineAsset): boolean {
    const month = this.manager.months.find((month) => month.getAssets().some((asset) => asset.id === cover.id));
    const scenes = month && this.loaded.get(month);
    const group = scenes?.groups.find((group) => group.coverId === cover.id);
    if (!month || !scenes || !group) {
      return false;
    }
    const children = group.members.filter((id) => id !== cover.id);
    if (scenes.expanded.has(group.id)) {
      scenes.expanded.delete(group.id);
      this.manager.hideSceneAssets(children);
    } else {
      scenes.expanded.add(group.id);
      month.addAssets(selectSceneRows(scenes.source, new Set(children)), true);
    }
    this.decorate(month);
    this.manager.refreshLayout();
    return true;
  }

  /** @param ids 真实资产变更的ID。@returns 无返回值；先展开受影响组再丢弃旧证据，防止缓存复活已删除照片。 */
  invalidate(ids: string[]): void {
    const changed = new Set(ids);
    for (const month of this.manager.months) {
      const scenes = this.loaded.get(month);
      if (!scenes) {
        continue;
      }
      let dirty = false;
      for (const group of [...scenes.groups]) {
        if (!group.members.some((id) => changed.has(id))) {
          continue;
        }
        dirty = true;
        if (!scenes.expanded.has(group.id)) {
          scenes.expanded.add(group.id);
          month.addAssets(
            selectSceneRows(scenes.source, new Set(group.members.filter((id) => id !== group.coverId))),
            true,
          );
        }
        scenes.groups = scenes.groups.filter((candidate) => candidate.id !== group.id);
      }
      if (dirty) {
        this.decorate(month);
        updateGeometry(this.manager, month, { invalidateHeight: true });
      }
    }
  }
}
