<script lang="ts">
  import { handleUpdateAlbumsCustomGroup } from '$lib/services/album.service';
  import { Field, FormModal, Input } from '@immich/ui';
  import { mdiFolderEditOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    albumIds: string[];
    onDone: () => void;
    onClose: () => void;
  };

  let { albumIds, onDone, onClose }: Props = $props();
  let customGroupName = $state('');

  const onSubmit = async () => {
    const success = await handleUpdateAlbumsCustomGroup(albumIds, customGroupName.trim() || null);
    if (success) {
      onDone();
      onClose();
    }
  };
</script>

<FormModal
  icon={mdiFolderEditOutline}
  title={$t('bulk_custom_group_title', { values: { count: albumIds.length } })}
  size="medium"
  {onClose}
  {onSubmit}
>
  <div class="m-4">
    <Field label={$t('custom_group')} description={$t('bulk_custom_group_description')}>
      <Input bind:value={customGroupName} placeholder={$t('custom_group_placeholder')} />
    </Field>
  </div>
</FormModal>
