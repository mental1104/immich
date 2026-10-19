<script lang="ts">
  import { Field, FormModal, Input, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: () => void;
    onCreate: (albumName: string) => Promise<boolean>;
  };

  let { onClose, onCreate }: Props = $props();
  let albumName = $state('');
  let isSubmitting = $state(false);

  const submit = async () => {
    const name = albumName.trim();
    if (!name || isSubmitting) {
      return;
    }

    isSubmitting = true;
    try {
      if (await onCreate(name)) {
        onClose();
      }
    } finally {
      isSubmitting = false;
    }
  };
</script>

<FormModal
  title={$t('create_album_from_search_results')}
  submitText={$t('create_album')}
  disabled={!albumName.trim() || isSubmitting}
  {onClose}
  onSubmit={submit}
>
  <Text size="tiny" class="mb-4" color="muted">{$t('create_album_from_search_results_description')}</Text>
  <Field label={$t('name')} required>
    <Input autofocus bind:value={albumName} disabled={isSubmitting} />
  </Field>
</FormModal>
