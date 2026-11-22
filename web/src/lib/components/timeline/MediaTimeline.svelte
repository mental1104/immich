<script lang="ts">
  import ActionMenuItem from '#lib/components/ActionMenuItem.svelte';
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '#lib/components/shared-components/EmptyPlaceholder.svelte';
  import ButtonContextMenu from '#lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import AssetSelectControlBar from '#lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '#lib/components/timeline/Timeline.svelte';
  import ChangeDate from '#lib/components/timeline/actions/ChangeDateAction.svelte';
  import ChangeDescription from '#lib/components/timeline/actions/ChangeDescriptionAction.svelte';
  import ChangeLocation from '#lib/components/timeline/actions/ChangeLocationAction.svelte';
  import DeleteAssets from '#lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '#lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '#lib/components/timeline/actions/FavoriteAction.svelte';
  import LinkLivePhotoAction from '#lib/components/timeline/actions/LinkLivePhotoAction.svelte';
  import SelectAllAssets from '#lib/components/timeline/actions/SelectAllAction.svelte';
  import SetVisibilityAction from '#lib/components/timeline/actions/SetVisibilityAction.svelte';
  import { AssetAction } from '#lib/constants.ts';
  import { assetMultiSelectManager } from '#lib/managers/asset-multi-select-manager.svelte.ts';
  import { assetViewerManager } from '#lib/managers/asset-viewer-manager.svelte.ts';
  import { TimelineManager } from '#lib/managers/timeline-manager/timeline-manager.svelte.ts';
  import { getAssetBulkActions } from '#lib/services/asset.service.ts';
  import { getStackBulkActions } from '#lib/services/stack.service.ts';
  import { type OnLink, type OnUnlink } from '#lib/utils/actions.ts';
  import { openFileUploadDialog } from '#lib/utils/file-uploader.ts';
  import { AssetTypeEnum, AssetVisibility } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider } from '@immich/ui';
  import { mdiDotsVertical } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { untrack } from 'svelte';

  /** assetType 限定当前媒体入口；title 为可选的本地化页面标题。 */
  interface Props {
    assetType: AssetTypeEnum;
    title?: string;
  }
  let { assetType, title }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  // 首次查询即使用保存的显示方式，避免onMount触发两轮并行初始化。
  let sceneStacks = $state(untrack(() => assetType === AssetTypeEnum.Image && readScenePreference()));

  /** @returns 浏览器保存的外层显示偏好；服务端或禁止存储时使用普通时间线。 */
  function readScenePreference(): boolean {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem('immich.scene-stacks') === 'true';
    } catch {
      return false;
    }
  }

  /** @param event 总开关变更；只改变Web显示偏好，不修改资产或原生叠放。 */
  const changeSceneStacks = (event: Event) => {
    sceneStacks = (event.currentTarget as HTMLInputElement).checked;
    try {
      localStorage.setItem('immich.scene-stacks', String(sceneStacks));
    } catch {
      // 存储不可用只影响下次访问，不阻止当前显示切换。
    }
  };
  // 在查询层限制媒体类型，使计数、分页、全选与查看器导航使用相同范围。
  const options = $derived({
    visibility: AssetVisibility.Timeline,
    withStacked: true,
    withPartners: true,
    assetType,
    sceneStacks,
  });

  let selectedAssets = $derived(assetMultiSelectManager.assets);
  let isLinkActionAvailable = $derived.by(() => {
    const isLivePhoto = selectedAssets.length === 1 && !!selectedAssets[0].livePhotoVideoId;
    const isLivePhotoCandidate =
      selectedAssets.length === 2 &&
      selectedAssets.some((asset) => asset.isImage) &&
      selectedAssets.some((asset) => asset.isVideo);

    return assetMultiSelectManager.isAllUserOwned && (isLivePhoto || isLivePhotoCandidate);
  });

  /** 关闭批量选择；查看器打开时交由查看器处理 Escape，无返回值。 */
  const handleEscape = () => {
    if (assetViewerManager.isViewing) {
      return;
    }
    if (assetMultiSelectManager.selectionActive) {
      assetMultiSelectManager.clear();
      return;
    }
  };

  /** still 为关联后的照片，motion 为隐藏的视频；同步本页显示，不再次写入资产。 */
  const handleLink: OnLink = ({ still, motion }) => {
    timelineManager.removeAssets([motion.id]);
    timelineManager.upsertAssets([still]);
  };

  /** still 和 motion 为解除关联后的资产；由当前媒体筛选决定接纳哪些资产。 */
  const handleUnlink: OnUnlink = ({ still, motion }) => {
    // 照片页解除实况关联后，独立视频交给视频页展示。
    if (assetType === AssetTypeEnum.Video) {
      timelineManager.upsertAssets([motion]);
    }
    timelineManager.upsertAssets([still]);
  };

  /** assetIds 为已改变可见性的资产 ID；从本页移除并结束选择，无返回值。 */
  const handleSetVisibility = (assetIds: string[]) => {
    timelineManager.removeAssets(assetIds);
    assetMultiSelectManager.clear();
  };
</script>

{#snippet sceneStackButton()}
  <label class="flex cursor-pointer items-center gap-2 px-3 text-sm">
    <input
      type="checkbox"
      checked={sceneStacks}
      onchange={changeSceneStacks}
      disabled={assetMultiSelectManager.selectionActive}
    />
    {$t('scene_stacks')}
  </label>
{/snippet}

<UserPageLayout
  {title}
  hideNavbar={assetMultiSelectManager.selectionActive}
  scrollbar={false}
  buttons={assetType === AssetTypeEnum.Image ? sceneStackButton : undefined}
>
  <Timeline
    enableRouting={true}
    bind:timelineManager
    {options}
    assetInteraction={assetMultiSelectManager}
    removeAction={AssetAction.ARCHIVE}
    onEscape={handleEscape}
    withStacked
  >
    {#snippet empty()}
      <EmptyPlaceholder text={$t('no_assets_message')} onClick={() => openFileUploadDialog()} class="mx-auto mt-10" />
    {/snippet}
  </Timeline>
</UserPageLayout>

{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    {const Actions = $derived(getAssetBulkActions($t))}
    {const StackActions = $derived(getStackBulkActions($t))}
    <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />

    <ActionButton action={Actions.CreateSharedLink} />
    <SelectAllAssets {timelineManager} assetInteraction={assetMultiSelectManager} />
    <ActionButton action={Actions.AddToAlbum} />

    {#if assetMultiSelectManager.isAllUserOwned}
      <FavoriteAction
        removeFavorite={assetMultiSelectManager.isAllFavorite}
        onFavorite={(ids, isFavorite) => timelineManager.update(ids, (asset) => (asset.isFavorite = isFavorite))}
      />

      <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
        <DownloadAction menuItem />
        <ActionMenuItem action={StackActions.Stack} />
        <ActionMenuItem action={StackActions.Unstack} />
        {#if isLinkActionAvailable}
          <LinkLivePhotoAction
            menuItem
            unlink={assetMultiSelectManager.assets.length === 1}
            onLink={handleLink}
            onUnlink={handleUnlink}
          />
        {/if}
        <ChangeDate menuItem />
        <ChangeDescription menuItem />
        <ChangeLocation menuItem />
        <ActionMenuItem action={Actions.Archive} />
        <ActionMenuItem action={Actions.Unarchive} />
        <ActionMenuItem action={Actions.Tag} />
        <DeleteAssets
          menuItem
          onAssetDelete={(assetIds) => timelineManager.removeAssets(assetIds)}
          onUndoDelete={(assets) => timelineManager.upsertAssets(assets)}
        />
        <SetVisibilityAction menuItem onVisibilitySet={handleSetVisibility} />
        <hr />
        <ActionMenuItem action={Actions.RegenerateThumbnailJob} />
        <ActionMenuItem action={Actions.RefreshMetadataJob} />
        <ActionMenuItem action={Actions.TranscodeVideoJob} />
      </ButtonContextMenu>
    {:else}
      <DownloadAction />
    {/if}
  </AssetSelectControlBar>
{/if}
