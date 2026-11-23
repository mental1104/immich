import { beforeEach, describe, expect, it, vi } from 'vitest';
import { querySceneStacks } from '#lib/queries/scene-stack.query.ts';
import { SceneStackSupport, selectSceneRows } from './scene-stacks.ts';
import type { TimelineManager } from './timeline-manager.svelte.ts';
import type { TimelineMonth } from './timeline-month.svelte.ts';
import type { TimelineAsset } from './types.ts';
import type { ViewerAsset } from './viewer-asset.svelte.ts';
import type { TimeBucketAssetResponseDto } from '@immich/sdk';

vi.mock('#lib/managers/timeline-manager/internal/layout-support.svelte.ts', () => ({ updateGeometry: vi.fn() }));
vi.mock('#lib/queries/scene-stack.query.ts', () => ({ querySceneStacks: vi.fn() }));

const nativeStack = ['native-stack', 3];

/** @param ids 原生桶中的真实顺序。@returns 具有可辨识列值及原生叠放的合成桶。 */
function bucket(ids: string[]): TimeBucketAssetResponseDto {
  return {
    id: ids,
    ownerId: ids.map(() => 'owner'),
    stack: ids.map((id) => (id === 'a' ? nativeStack : null)),
    city: null,
    ratio: ids.map((_, index) => index + 1),
  } as unknown as TimeBucketAssetResponseDto;
}

/** 仅模拟原生容器的追加和排序行为；不在夹具中实现任何相似组重排。 */
interface TestDay {
  day: number;
  viewerAssets: ViewerAsset[];
}

/** @param source 原生桶。@param dates 可选日归属。@returns 可观察原始顺序、容器及场景支持的独立夹具。 */
function timeline(source: TimeBucketAssetResponseDto, dates: Readonly<Record<string, number>> = {}) {
  const rank = new Map(source.id.map((id, index) => [id, index]));
  const stub = {
    timelineDays: [] as TestDay[],
    getAssets: (): TimelineAsset[] =>
      stub.timelineDays.flatMap((day) => day.viewerAssets.map((viewer) => viewer.asset)),
    /** 按原生语义追加行；只有preSorted=false才对当天已有数据重新排序。 */
    addAssets: (rows: TimeBucketAssetResponseDto, preSorted: boolean): TimelineAsset[] => {
      rows.id.forEach((id, index) => {
        const date = dates[id] ?? 1;
        let day = stub.timelineDays.find((day) => day.day === date);
        if (!day) {
          day = { day: date, viewerAssets: [] };
          stub.timelineDays.push(day);
        }
        const asset = {
          id,
          stack: rows.stack?.[index],
          localDateTime: { year: 2026, month: 11, day: date },
        } as unknown as TimelineAsset;
        day.viewerAssets.push({ id, asset } as ViewerAsset);
      });
      if (!preSorted) {
        for (const day of stub.timelineDays) {
          day.viewerAssets.sort((left, right) => rank.get(left.id)! - rank.get(right.id)!);
        }
        stub.timelineDays.sort((left, right) => right.day - left.day);
      }
      return [];
    },
  };
  const month = stub as unknown as TimelineMonth;
  const manager = {
    months: [month],
    /** 显示移除保留其他照片，不模拟真实资产删除。 */
    hideSceneAssets: (ids: string[]): string[] => {
      for (const day of stub.timelineDays) {
        day.viewerAssets = day.viewerAssets.filter((viewer) => !ids.includes(viewer.id));
      }
      stub.timelineDays = stub.timelineDays.filter((day) => day.viewerAssets.length > 0);
      return [];
    },
    refreshLayout: vi.fn(),
  } as unknown as TimelineManager;
  const scenes = new SceneStackSupport(manager);
  return {
    month,
    scenes,
    stub,
    order: () => stub.getAssets().map((asset) => asset.id),
    asset: (id: string) => stub.getAssets().find((asset) => asset.id === id)!,
    /** 首次加载只插入场景支持返回的可见行。 */
    load: async () => {
      stub.addAssets(await scenes.prepare(month, source, new AbortController().signal), true);
      scenes.decorate(month);
    },
  };
}

/** 检查的是确切相对顺序，而不只检查展开后“有照片出现”。 */
describe('outer scene stacks', () => {
  beforeEach(() => {
    vi.mocked(querySceneStacks)
      .mockReset()
      .mockResolvedValue([{ id: 'group', coverId: 'a', members: ['a', 'b'] }]);
  });

  it('projects all columns together and retains native stacks', () => {
    const selected = selectSceneRows(bucket(['a', 'b', 'c']), new Set(['a', 'c']));
    expect(selected.id).toEqual(['a', 'c']);
    expect(selected.ratio).toEqual([1, 3]);
    expect(selected.city).toBeNull();
    expect(selected.stack).toEqual([nativeStack, null]);
  });

  it('keeps expanded members immediately after their cover across repeated toggles', async () => {
    const lab = timeline(bucket(['lead', 'a', 'middle', 'b', 'tail']));
    await lab.load();
    expect(lab.order()).toEqual(['lead', 'a', 'middle', 'tail']);
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(lab.scenes.toggle(lab.asset('a'))).toBe(true);
      expect(lab.order()).toEqual(['lead', 'a', 'b', 'middle', 'tail']);
      expect(lab.asset('a').stack).toEqual(nativeStack);
      lab.scenes.toggle(lab.asset('a'));
      expect(lab.order()).toEqual(['lead', 'a', 'middle', 'tail']);
    }
  });

  it('keeps two independently expanded groups contiguous', async () => {
    vi.mocked(querySceneStacks).mockResolvedValue([
      { id: 'first', coverId: 'a', members: ['a', 'b'] },
      { id: 'second', coverId: 'd', members: ['d', 'e'] },
    ]);
    const lab = timeline(bucket(['a', 'middle', 'b', 'd', 'other', 'e', 'tail']));
    await lab.load();
    lab.scenes.toggle(lab.asset('d'));
    lab.scenes.toggle(lab.asset('a'));
    expect(lab.order()).toEqual(['a', 'b', 'middle', 'd', 'e', 'other', 'tail']);
    lab.scenes.toggle(lab.asset('a'));
    expect(lab.order()).toEqual(['a', 'middle', 'd', 'e', 'other', 'tail']);
  });

  it('restores adjacency after native reordering without replacing stable reactive arrays', async () => {
    const lab = timeline(bucket(['a', 'middle', 'b', 'tail']));
    await lab.load();
    lab.scenes.toggle(lab.asset('a'));
    const day = lab.stub.timelineDays[0];
    const nativeRank = new Map(['a', 'middle', 'b', 'tail'].map((id, index) => [id, index]));
    day.viewerAssets.sort((left, right) => nativeRank.get(left.id)! - nativeRank.get(right.id)!);
    lab.scenes.arrange(lab.month);
    expect(lab.order()).toEqual(['a', 'b', 'middle', 'tail']);
    const stable = day.viewerAssets;
    lab.scenes.arrange(lab.month);
    expect(day.viewerAssets).toBe(stable);
  });

  it('anchors cross-day groups without changing dates and restores native days when invalidated', async () => {
    const lab = timeline(bucket(['a', 'newer', 'b', 'older']), { a: 2, newer: 2, b: 1, older: 1 });
    await lab.load();
    lab.scenes.toggle(lab.asset('a'));
    expect(lab.stub.timelineDays.map((day) => day.viewerAssets.map((viewer) => viewer.id))).toEqual([
      ['a', 'b', 'newer'],
      ['older'],
    ]);
    expect(lab.asset('b').localDateTime.day).toBe(1);
    lab.scenes.invalidate(['b']);
    expect(lab.stub.timelineDays.map((day) => day.viewerAssets.map((viewer) => viewer.id))).toEqual([
      ['a', 'newer'],
      ['b', 'older'],
    ]);
    expect(lab.asset('a').sceneStack).toBeUndefined();
    expect(lab.scenes.toggle(lab.asset('a'))).toBe(false);
  });

  it('restores hidden children at their native positions when a collapsed group changes', async () => {
    const lab = timeline(bucket(['a', 'middle', 'b', 'tail']));
    await lab.load();
    lab.scenes.invalidate(['b']);
    expect(lab.order()).toEqual(['a', 'middle', 'b', 'tail']);
    expect(lab.asset('a').sceneStack).toBeUndefined();
  });

  it('retains the complete native order when no usable scene evidence exists', async () => {
    vi.mocked(querySceneStacks).mockRejectedValue(new Error('Unavailable'));
    const lab = timeline(bucket(['a', 'middle', 'b', 'tail']));
    await lab.load();
    expect(lab.order()).toEqual(['a', 'middle', 'b', 'tail']);
    expect(lab.asset('a').stack).toEqual(nativeStack);
    expect(lab.scenes.toggle(lab.asset('a'))).toBe(false);
  });
});
