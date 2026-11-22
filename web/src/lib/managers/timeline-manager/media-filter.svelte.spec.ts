import { TimelineManager } from '#lib/managers/timeline-manager/timeline-manager.svelte.ts';
import { toTimelineAsset } from '#lib/utils/timeline-util.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { AssetTypeEnum } from '@immich/sdk';
import { expect } from 'vitest';

/** 每种入口都检查公开桶请求及后续实时资产，防止类型隔离只在首次加载有效。 */
for (const assetType of [AssetTypeEnum.Image, AssetTypeEnum.Video]) {
  /** api 提供隔离接口记录；空图库也必须保留服务端过滤和实时过滤。 */
  test(`keeps ${assetType} filtering for requests and live updates`, async ({ api }) => {
    const manager = new TimelineManager();
    try {
      await manager.updateOptions({ assetType });
      expect(api.getTimeBuckets).toHaveBeenCalledWith({ params: expect.objectContaining({ assetType }) });
      const image = toTimelineAsset(factory.asset({ type: AssetTypeEnum.Image }));
      const video = toTimelineAsset(factory.asset({ type: AssetTypeEnum.Video }));
      expect(manager.canInsertAssetFromLiveEvent(image)).toBe(assetType === AssetTypeEnum.Image);
      expect(manager.canInsertAssetFromLiveEvent(video)).toBe(assetType === AssetTypeEnum.Video);
    } finally {
      manager.destroy();
    }
  });
}
