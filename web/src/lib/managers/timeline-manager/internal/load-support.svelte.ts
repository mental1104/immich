import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { toISOYearMonthUTC } from '#lib/utils/timeline-util.ts';
import { getTimeBucket } from '@immich/sdk';
import { TimelineManager } from '../timeline-manager.svelte';
import type { TimelineMonth } from '../timeline-month.svelte';
import type { TimelineManagerOptions } from '../types';

export async function loadFromTimeBuckets(
  timelineManager: TimelineManager,
  timelineMonth: TimelineMonth,
  options: TimelineManagerOptions,
  signal: AbortSignal,
): Promise<void> {
  if (timelineMonth.getFirstAsset()) {
    return;
  }

  const timeBucket = toISOYearMonthUTC(timelineMonth.yearMonth);
  const { sceneStacks, ...nativeOptions } = options;
  const bucketResponse = await getTimeBucket(
    {
      ...authManager.params,
      ...nativeOptions,
      timeBucket,
    },
    { signal },
  );

  if (!bucketResponse || signal.aborted) {
    return;
  }

  if (options.timelineAlbumId) {
    const albumAssets = await getTimeBucket(
      {
        ...authManager.params,
        albumId: options.timelineAlbumId,
        timeBucket,
      },
      { signal },
    );
    if (!albumAssets || signal.aborted) {
      return;
    }
    for (const id of albumAssets.id) {
      timelineManager.albumAssets.add(id);
    }
  }

  const visible = sceneStacks
    ? await timelineManager.sceneStacks.prepare(timelineMonth, bucketResponse, signal)
    : bucketResponse;
  if (signal.aborted) {
    return;
  }
  const unprocessedAssets = timelineMonth.addAssets(visible, true);
  timelineManager.sceneStacks.decorate(timelineMonth);
  if (unprocessedAssets.length > 0) {
    console.error(
      `Warning: getTimeBucket API returning assets not in requested month: ${timelineMonth.yearMonth.month}, ${JSON.stringify(
        unprocessedAssets.map((unprocessed) => ({
          id: unprocessed.id,
          localDateTime: unprocessed.localDateTime,
        })),
      )}`,
    );
  }
}
