<script lang="ts">
  import MediaTimeline from '#lib/components/timeline/MediaTimeline.svelte';
  import { AssetTypeEnum } from '@immich/sdk';
  import { t } from 'svelte-i18n';
</script>

<MediaTimeline assetType={AssetTypeEnum.Video} title={$t('videos')} />
