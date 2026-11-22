import { AssetTypeEnum, AssetVisibility, searchRandom } from '@immich/sdk';
import { queryOptions } from '@tanstack/svelte-query';

export const searchQueryKey = ['search'] as const;

/** 无参数；返回最多 60 张可见照片的随机查询，排除视频、归档、锁定和垃圾箱资产。 */
export const getRandomPhotosQuery = () =>
  queryOptions({
    queryKey: [...searchQueryKey, 'random-photos'],
    // 查看器打开、关闭和重新聚焦时保留当前批次，避免用户浏览途中照片被替换。
    staleTime: Infinity,
    // 显式限定可见范围；请求失败由共享查询错误处理显示，取消信号传给 SDK。
    queryFn: ({ signal }) =>
      searchRandom(
        {
          randomSearchDto: {
            type: AssetTypeEnum.Image,
            visibility: AssetVisibility.Timeline,
            size: 60,
            withDeleted: false,
          },
        },
        { signal },
      ),
  });
