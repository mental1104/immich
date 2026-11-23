<script lang="ts">
  import { searchManager } from '#lib/managers/search-manager.svelte.ts';
  import { executeMutation, queryClient } from '#lib/queries/client.ts';
  import { getSearchPresetsQuery, searchPresetMutation, type SearchPreset } from '#lib/queries/search-preset.query.ts';
  import {
    builtInSearchPresets,
    combineSearchConditions,
    getSearchConditionAtoms,
    type SearchPresetConditions,
  } from '#lib/utils/search-presets.ts';
  import { Button, Checkbox, Field, Input, Modal, ModalBody } from '@immich/ui';
  import { createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';

  /** 选择当前原子条件登记，或把内置/自有登记项还原到编辑器；应用不自动提交搜索。 */
  type Props = { onClose: () => void; onApply: () => void };
  const { onClose, onApply }: Props = $props();
  const presets = createQuery(getSearchPresetsQuery, () => queryClient);
  let draftAtoms = $state(searchManager.conditionAtoms);
  let selected = $state(draftAtoms.map(({ id }) => id));
  let name = $state('');
  let editing = $state<string | null>(null);
  let deleting = $state<string | null>(null);
  let busy = $state(false);

  /** @param conditions 登记中明确指定的字段。@returns 无；保留其他条件，关闭弹框后让原搜索面板继续编辑。 */
  function apply(conditions: SearchPresetConditions) {
    searchManager.applyPreset(conditions);
    onClose();
    onApply();
  }
  /** @param preset 自有登记项。@returns 无；只更新编辑草稿，不触碰正在使用的搜索条件。 */
  function edit(preset: SearchPreset) {
    editing = preset.id;
    name = preset.name;
    draftAtoms = getSearchConditionAtoms(preset.conditions, $t);
    selected = draftAtoms.map(({ id }) => id);
  }
  /** @returns 仅勾选的条件持久化到当前账号；成功后清除名称，失败保留编辑内容。 */
  async function save() {
    busy = true;
    try {
      await executeMutation(
        searchPresetMutation,
        [
          {
            method: editing ? 'PATCH' : 'POST',
            id: editing ?? undefined,
            name,
            conditions: combineSearchConditions(draftAtoms.filter(({ id }) => selected.includes(id))),
          },
        ],
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
  /** @param id 已确认删除的自有登记项。@returns 删除完成；失败保留确认状态。 */
  async function remove(id: string) {
    busy = true;
    try {
      await executeMutation(searchPresetMutation, [{ method: 'DELETE', id }], {
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

<Modal title={$t('search_presets')} size="large" {onClose}>
  <ModalBody>
    <div class="flex flex-col gap-5 p-4">
      <p class="text-sm text-immich-fg/70 dark:text-immich-dark-fg/70">{$t('search_presets_hint')}</p>
      <section aria-label={$t('search_preset_register')} class="rounded-xl border p-4">
        <form
          class="flex flex-col gap-3"
          onsubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div class="flex flex-wrap items-end gap-2">
            <Field label={$t(editing ? 'search_preset_edit' : 'search_preset_name')}
              ><Input bind:value={name} maxlength={100} required /></Field
            >
            <Button type="submit" disabled={busy || !name.trim() || selected.length === 0}>{$t('save')}</Button>
            <Button
              variant="ghost"
              disabled={busy}
              onclick={() => {
                draftAtoms = searchManager.conditionAtoms;
                selected = draftAtoms.map(({ id }) => id);
              }}>{$t('search_preset_current')}</Button
            >
            {#if editing}<Button
                variant="ghost"
                onclick={() => {
                  editing = null;
                  name = '';
                }}>{$t('cancel')}</Button
              >{/if}
          </div>
          {#if draftAtoms.length === 0}<p class="text-sm text-immich-fg/70 dark:text-immich-dark-fg/70">
              {$t('search_preset_empty')}
            </p>{/if}
          {#each draftAtoms as atom (atom.id)}
            <label class="flex items-center gap-2 text-sm">
              <Checkbox
                id="preset-{atom.id}"
                checked={selected.includes(atom.id)}
                aria-label={atom.label}
                onCheckedChange={(checked) => {
                  selected = checked ? [...selected, atom.id] : selected.filter((id) => id !== atom.id);
                }}
              />
              <span class="wrap-break-word">{atom.label}</span>
            </label>
          {/each}
        </form>
      </section>
      <section aria-label={$t('search_presets_custom')}>
        <h3 class="mb-2 font-semibold">{$t('search_presets_custom')}</h3>
        {#if presets.isError}<Button onclick={() => presets.refetch()}>{$t('retry')}</Button>{/if}
        {#each presets.data ?? [] as preset (preset.id)}
          <div class="mb-2 flex flex-wrap items-center gap-2 rounded-xl border p-3">
            <div class="min-w-0 grow">
              <p class="font-medium">{preset.name}</p>
              <p class="text-xs text-immich-fg/70 dark:text-immich-dark-fg/70">
                {getSearchConditionAtoms(preset.conditions, $t)
                  .map(({ label }) => label)
                  .join(' · ')}
              </p>
            </div>
            <Button size="small" disabled={busy} onclick={() => apply(preset.conditions)}
              >{$t('search_preset_apply')}</Button
            >
            <Button size="small" variant="ghost" disabled={busy} onclick={() => edit(preset)}>{$t('edit')}</Button>
            <Button size="small" variant="ghost" disabled={busy} onclick={() => (deleting = preset.id)}
              >{$t('delete')}</Button
            >
            {#if deleting === preset.id}
              <Button size="small" color="danger" disabled={busy} onclick={() => remove(preset.id)}
                >{$t('confirm')}</Button
              >
              <Button size="small" variant="ghost" onclick={() => (deleting = null)}>{$t('cancel')}</Button>
            {/if}
          </div>
        {/each}
      </section>
      <section aria-label={$t('search_presets_builtin')}>
        <h3 class="mb-2 font-semibold">{$t('search_presets_builtin')}</h3>
        <div class="grid gap-2 sm:grid-cols-2">
          {#each builtInSearchPresets as preset (preset.id)}
            <div class="rounded-xl border p-3">
              <p class="font-medium">{$t(preset.title)}</p>
              <p class="my-2 text-xs text-immich-fg/70 dark:text-immich-dark-fg/70">{$t(preset.description)}</p>
              <Button size="small" variant="outline" onclick={() => apply(preset.conditions)}
                >{$t('search_preset_apply')}</Button
              >
            </div>
          {/each}
        </div>
      </section>
    </div>
  </ModalBody>
</Modal>
