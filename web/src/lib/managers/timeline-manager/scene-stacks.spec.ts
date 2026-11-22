import { describe, expect, it, vi } from 'vitest';
import { SceneStackSupport, selectSceneRows } from './scene-stacks.ts';
import type { TimelineManager } from './timeline-manager.svelte.ts';
import type { TimelineMonth } from './timeline-month.svelte.ts';
import type { TimelineAsset } from './types.ts';
import type { TimeBucketAssetResponseDto } from '@immich/sdk';

vi.mock('#lib/managers/timeline-manager/internal/layout-support.svelte.ts', () => ({ updateGeometry: vi.fn() }));
vi.mock('#lib/queries/scene-stack.query.ts', () => ({
  querySceneStacks: vi.fn(async () => [{ id: 'group', coverId: 'a', members: ['a', 'b'] }]),
}));

/** 验证按行过滤、反复展开和资产变化，原生stack字段始终保持原值。 */
describe('outer scene stacks', () => {
  const nativeStack = ['native-stack', 3];
  const source = {
    id: ['a', 'b', 'c'],
    ownerId: ['owner', 'owner', 'owner'],
    stack: [nativeStack, null, null],
    city: null,
    ratio: [1, 2, 3],
  } as unknown as TimeBucketAssetResponseDto;

  it('projects all populated columns together while retaining null columns and native stacks', () => {
    const selected = selectSceneRows(source, new Set(['a', 'c']));
    expect(selected.id).toEqual(['a', 'c']);
    expect(selected.ratio).toEqual([1, 3]);
    expect(selected.city).toBeNull();
    expect(selected.stack).toEqual([nativeStack, null]);
  });

  it('expands and collapses repeatedly without unpacking native stacks, then unfolds on real changes', async () => {
    let visible: TimelineAsset[] = [];
    /** @param bucket 待插入的原生行。@returns 无返回值；保留原生叠放用于断言。 */
    const addAssets = (bucket: TimeBucketAssetResponseDto) => {
      visible.push(...bucket.id.map((id, index) => ({ id, stack: bucket.stack?.[index] }) as unknown as TimelineAsset));
    };
    const month = { getAssets: () => visible, addAssets } as unknown as TimelineMonth;
    const manager = {
      months: [month],
      hideSceneAssets: (ids: string[]) => {
        visible = visible.filter((asset) => !ids.includes(asset.id));
      },
      refreshLayout: vi.fn(),
    } as unknown as TimelineManager;
    const scenes = new SceneStackSupport(manager);
    const folded = await scenes.prepare(month, source, new AbortController().signal);
    expect(folded.id).toEqual(['a', 'c']);
    addAssets(folded);
    scenes.decorate(month);
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(scenes.toggle(visible[0])).toBe(true);
      expect(visible.map((asset) => asset.id).sort()).toEqual(['a', 'b', 'c']);
      expect(visible[0].stack).toEqual(nativeStack);
      scenes.toggle(visible[0]);
      expect(visible.map((asset) => asset.id)).toEqual(['a', 'c']);
    }
    scenes.invalidate(['b']);
    expect(visible.map((asset) => asset.id).sort()).toEqual(['a', 'b', 'c']);
    expect(visible[0].sceneStack).toBeUndefined();
    expect(scenes.toggle(visible[0])).toBe(false);
  });
});
