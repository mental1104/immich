<script lang="ts">
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getAllTags,
    updateAlbumInfo,
    upsertTags,
    type TagResponseDto,
  } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import Combobox, {
    type ComboBoxOption,
  } from '$lib/components/shared-components/Combobox.svelte';
  import TagPill from '$lib/components/shared-components/TagPill.svelte';

  interface Props {
    id: string;
    tags: TagResponseDto[];
    isEditor: boolean;
    onUpdate: (tags: TagResponseDto[]) => void;
  }

  let { id, tags, isEditor, onUpdate }: Props = $props();
  let allTags: TagResponseDto[] = $state([]);
  let saving = $state(false);

  onMount(async () => {
    try {
      allTags = await getAllTags();
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_album'));
    }
  });

  const save = async (tagIds: string[]) => {
    if (saving) {
      return;
    }
    saving = true;
    try {
      const album = await updateAlbumInfo({ id, updateAlbumDto: { tagIds } });
      eventManager.emit('AlbumUpdate', album);
      onUpdate(album.tags ?? []);
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_album'));
    } finally {
      saving = false;
    }
  };

  const handleSelect = async (option?: ComboBoxOption) => {
    if (!option || saving) {
      return;
    }

    try {
      let tagId = option.value;
      if (!option.id) {
        const [newTag] = await upsertTags({
          tagUpsertDto: { tags: [option.label] },
        });
        allTags = [...allTags, newTag];
        tagId = newTag.id;
      }
      if (!tags.some((tag) => tag.id === tagId)) {
        await save([...tags.map((tag) => tag.id), tagId]);
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_album'));
    }
  };
</script>

<div class="my-3 flex flex-wrap items-center gap-2">
  {#if isEditor}
    <Combobox
      onSelect={handleSelect}
      label={$t('tag')}
      allowCreate
      defaultFirstOption
      options={allTags.map((tag) => ({
        id: tag.id,
        label: tag.value,
        value: tag.id,
      }))}
      placeholder={$t('search_tags')}
      disabled={saving}
    />
    {#each tags as tag (tag.id)}
      <TagPill
        label={tag.value}
        onRemove={() =>
          save(
            tags.filter((item) => item.id !== tag.id).map((item) => item.id),
          )}
      />
    {/each}
  {:else}
    {#each tags as tag (tag.id)}
      <span class="rounded-full bg-primary px-3 py-1 text-sm text-gray-100"
        >{tag.value}</span
      >
    {/each}
  {/if}
</div>
