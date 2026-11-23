<script lang="ts">
  import { albumCategoryMutation, getAlbumCategoriesQuery } from '#lib/queries/album-category.query.ts';
  import { executeMutation, queryClient } from '#lib/queries/client.ts';
  import { Button, Field, Input, Modal, ModalBody } from '@immich/ui';
  import { createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';

  /** 维护个人大组与整组归属；已有相簿数据和共享设置保持原样。 */
  type Props = { groupNames: string[]; onClose: () => void };
  const { groupNames, onClose }: Props = $props();
  const directory = createQuery(getAlbumCategoriesQuery, () => queryClient);
  let name = $state('');
  let editing = $state<string | null>(null);
  let busy = $state(false);
  let deleting = $state<string | null>(null);

  /** @returns 保存名称后清空编辑态；失败保留输入以便修正。 */
  async function saveName() {
    busy = true;
    try {
      await executeMutation(
        albumCategoryMutation,
        [editing ? { method: 'PATCH', id: editing, name } : { method: 'POST', name }],
        {
          onSuccess: () => {
            name = '';
            editing = null;
          },
        },
      );
    } finally {
      busy = false;
    }
  }

  /** @param groupName 原分组名。@param categoryId 空字符串回默认。@returns 归属写入完成后解除禁用。 */
  async function assign(groupName: string, categoryId: string) {
    busy = true;
    try {
      await executeMutation(albumCategoryMutation, [{ method: 'PUT', groupName, categoryId: categoryId || null }]);
    } finally {
      busy = false;
    }
  }

  /** @param id 要删除的自有大组。@returns 确认后删除，里面的分组回默认。 */
  async function remove(id: string) {
    busy = true;
    try {
      await executeMutation(albumCategoryMutation, [{ method: 'DELETE', id }], {
        onSuccess: () => {
          deleting = null;
          if (editing === id) {
            editing = null;
            name = '';
          }
        },
      });
    } finally {
      busy = false;
    }
  }
</script>

<Modal title={$t('album_categories_manage')} size="medium" {onClose}>
  <ModalBody>
    <div class="flex flex-col gap-5 p-4">
      <p class="text-sm text-immich-fg/70 dark:text-immich-dark-fg/70">{$t('album_categories_hint')}</p>
      {#if directory.isError}
        <Button onclick={() => directory.refetch()}>{$t('retry')}</Button>
      {:else}
        <form
          class="flex items-end gap-2"
          onsubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
        >
          <Field label={$t(editing ? 'rename' : 'album_category_create')}>
            <Input bind:value={name} maxlength={100} required />
          </Field>
          <Button type="submit" disabled={busy || !name.trim()}>{$t('save')}</Button>
          {#if editing}<Button
              variant="ghost"
              onclick={() => {
                editing = null;
                name = '';
              }}>{$t('cancel')}</Button
            >{/if}
        </form>
        {#each directory.data?.categories ?? [] as category (category.id)}
          <div class="flex flex-wrap items-center gap-2">
            <span class="grow font-medium">{category.name}</span>
            <Button
              size="small"
              variant="ghost"
              disabled={busy}
              onclick={() => {
                editing = category.id;
                name = category.name;
              }}>{$t('rename')}</Button
            >
            <Button size="small" variant="ghost" disabled={busy} onclick={() => (deleting = category.id)}
              >{$t('delete')}</Button
            >
            {#if deleting === category.id}
              <p class="w-full text-sm">{$t('album_category_delete_hint')}</p>
              <Button size="small" color="danger" disabled={busy} onclick={() => remove(category.id)}
                >{$t('confirm')}</Button
              >
              <Button size="small" variant="ghost" disabled={busy} onclick={() => (deleting = null)}
                >{$t('cancel')}</Button
              >
            {/if}
          </div>
        {/each}
        <div class="flex flex-col gap-2 border-t pt-4">
          {#each groupNames as groupName (groupName)}
            <label class="flex items-center justify-between gap-4 text-sm">
              <span class="truncate">{groupName || $t('ungrouped')}</span>
              <select
                class="max-w-1/2 rounded-lg border bg-transparent p-2"
                aria-label={$t('album_category_for_group', { values: { group: groupName || $t('ungrouped') } })}
                value={directory.data?.groups.find((group) => group.groupName === groupName)?.categoryId ?? ''}
                disabled={busy || !directory.data}
                onchange={(event) => assign(groupName, event.currentTarget.value)}
              >
                <option value="">{$t('album_category_default')}</option>
                {#each directory.data?.categories ?? [] as category (category.id)}<option value={category.id}
                    >{category.name}</option
                  >{/each}
              </select>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  </ModalBody>
</Modal>
