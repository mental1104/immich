<script lang="ts">
  import MediaTimeline from '#lib/components/timeline/MediaTimeline.svelte';
  import { AssetTypeEnum } from '@immich/sdk';
</script>

<MediaTimeline assetType={AssetTypeEnum.Image} />
