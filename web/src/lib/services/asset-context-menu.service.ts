import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { getAlbumAssetActions, isAlbumEditor } from '#lib/services/album.service.ts';
import { getAssetActions } from '#lib/services/asset.service.ts';
import { navigate } from '#lib/utils/navigation.ts';
import { AssetVisibility, type AlbumResponseDto, type AssetResponseDto } from '@immich/sdk';
import type { ActionItem } from '@immich/ui';
import { mdiImageOutline } from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';

/**
为时间线中右键点中的单张资产生成菜单，不读取或修改全局多选集合。
@param $t 当前语言的格式化器。
@param asset 通过权限检查读取的完整单张资产，不能用叠放成员或已选集合替换。
@param album 当前相簿；首页省略，只有相簿编辑者可设置其封面。
@returns 当前账号可执行的单张操作；未登录、分享链接、锁定或已删除资产返回空数组。
*/
export function getAssetContextMenuActions(
  $t: MessageFormatter,
  asset: AssetResponseDto,
  album?: AlbumResponseDto,
): ActionItem[] {
  if (
    !authManager.authenticated ||
    authManager.isSharedLink ||
    asset.isTrashed ||
    asset.visibility === AssetVisibility.Locked
  ) {
    return [];
  }
  const actions = getAssetActions($t, asset, album);
  const items: ActionItem[] = [
    {
      title: $t('open'),
      icon: mdiImageOutline,
      onAction: () => navigate({ targetRoute: 'current', assetId: asset.id }),
    },
  ];
  if (album && isAlbumEditor(album)) {
    items.push(getAlbumAssetActions($t, album, asset).SetCover);
  }
  items.push(
    actions.Favorite,
    actions.Unfavorite,
    actions.AddToAlbum,
    actions.Download,
    actions.Share,
    {
      ...actions.Tag,
      // 相簿访问权不等于编辑他人照片的元数据权限。
      $if: () => asset.ownerId === authManager.user.id && (actions.Tag.$if?.() ?? true),
    },
    actions.RemoveFromAlbum,
  );
  return items.filter((item) => item.$if?.() ?? true);
}
