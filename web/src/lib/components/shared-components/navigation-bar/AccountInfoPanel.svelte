<script lang="ts">
  import { focusTrap } from '#lib/actions/focus-trap.ts';
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import AvatarEditModal from '#lib/modals/AvatarEditModal.svelte';
  import HelpAndFeedbackModal from '#lib/modals/HelpAndFeedbackModal.svelte';
  import { getUserConfigQuery } from '#lib/queries/config-user.query.ts';
  import { getAboutInfoQuery } from '#lib/queries/server-info.query.ts';
  import { Route } from '#lib/route.ts';
  import { Button, Icon, IconButton, modalManager } from '@immich/ui';
  import {
    mdiAccountMultipleOutline,
    mdiArchiveArrowDownOutline,
    mdiChevronDown,
    mdiChevronUp,
    mdiCog,
    mdiLockOutline,
    mdiLogout,
    mdiPencil,
    mdiToolboxOutline,
    mdiTrashCanOutline,
    mdiWrench,
  } from '@mdi/js';
  import { createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import { page } from '$app/state';
  import UserAvatar from '../UserAvatar.svelte';

  type Props = {
    onClose?: () => void;
  };

  let { onClose }: Props = $props();

  const query = createQuery(getAboutInfoQuery);
  const info = $derived(query.data);
  const configQuery = createQuery(getUserConfigQuery);
  let showMore = $state(false);

  /** 展开或收起低频入口；不修改功能开关、权限或当前路由。@returns 更新后的展开状态。 */
  const toggleMore = () => (showMore = !showMore);
</script>

<div
  in:fade={{ duration: 100 }}
  out:fade={{ duration: 100 }}
  id="account-info-panel"
  class="absolute inset-e-6 top-19 z-1 max-h-[calc(100dvh-6rem)] w-[min(360px,100vw-50px)] overflow-y-auto rounded-3xl bg-gray-200 shadow-lg dark:border dark:border-immich-dark-gray dark:bg-immich-dark-gray"
  use:focusTrap
>
  <div
    class="mx-4 mt-4 flex flex-col items-center justify-center gap-4 rounded-t-3xl bg-white p-4 dark:bg-immich-dark-primary/10"
  >
    <div class="relative">
      <UserAvatar user={authManager.user} size="xl" />
      <div class="absolute inset-e-0 bottom-0 size-6 rounded-full">
        <IconButton
          color="primary"
          icon={mdiPencil}
          aria-label={$t('edit_avatar')}
          size="tiny"
          shape="round"
          onclick={async () => {
            onClose?.();
            await modalManager.show(AvatarEditModal);
          }}
        />
      </div>
    </div>
    <div>
      <p class="text-center text-lg font-medium text-primary">
        {authManager.user.name}
      </p>
      <p class="text-sm text-gray-500 dark:text-immich-dark-fg">{authManager.user.email}</p>
    </div>

    <div class="flex flex-col gap-1">
      <Button
        href={Route.userSettings()}
        onclick={onClose}
        size="small"
        color="secondary"
        variant="ghost"
        shape="round"
        class="border hover:bg-immich-primary/10 dark:border-immich-dark-gray dark:bg-gray-500 dark:text-white dark:hover:bg-immich-dark-primary/50"
      >
        <div class="flex place-content-center place-items-center gap-2 px-2 text-center">
          <Icon icon={mdiCog} size="18" aria-hidden />
          {$t('account_settings')}
        </div>
      </Button>
      {#if authManager.user.isAdmin}
        <Button
          href={Route.systemSettings()}
          onclick={onClose}
          shape="round"
          variant="ghost"
          size="small"
          color="secondary"
          aria-current={page.url.pathname.includes('/admin') ? 'page' : undefined}
          class="border hover:bg-immich-primary/10 dark:border-immich-dark-gray dark:bg-gray-500 dark:text-white dark:hover:bg-immich-dark-primary/50"
        >
          <div class="flex place-content-center place-items-center gap-2 px-2 text-center">
            <Icon icon={mdiWrench} size="18" aria-hidden />
            {$t('administration')}
          </div>
        </Button>
      {/if}
    </div>

    <!-- 低频导航只在用户主动展开后显示；仍使用原路由和锁定文件夹的 PIN 校验。 -->
    <div class="w-full">
      <Button
        onclick={toggleMore}
        aria-expanded={showMore}
        aria-controls="account-more-navigation"
        leadingIcon={showMore ? mdiChevronUp : mdiChevronDown}
        size="small"
        color="secondary"
        variant="ghost"
        shape="round"
        class="w-full"
      >
        {$t('more')}
      </Button>
      {#if showMore}
        <nav id="account-more-navigation" aria-label={$t('more')} class="mt-2 flex flex-col gap-1">
          <Button
            href={Route.sharing()}
            onclick={onClose}
            leadingIcon={mdiAccountMultipleOutline}
            variant="ghost"
            color="secondary"
            size="small">{$t('sharing')}</Button
          >
          <Button
            href={Route.utilities()}
            onclick={onClose}
            leadingIcon={mdiToolboxOutline}
            variant="ghost"
            color="secondary"
            size="small">{$t('utilities')}</Button
          >
          <Button
            href={Route.archive()}
            onclick={onClose}
            leadingIcon={mdiArchiveArrowDownOutline}
            variant="ghost"
            color="secondary"
            size="small">{$t('archive')}</Button
          >
          <Button
            href={Route.locked()}
            onclick={onClose}
            leadingIcon={mdiLockOutline}
            variant="ghost"
            color="secondary"
            size="small">{$t('locked_folder')}</Button
          >
          {#if configQuery.data?.trash.enabled}
            <Button
              href={Route.trash()}
              onclick={onClose}
              leadingIcon={mdiTrashCanOutline}
              variant="ghost"
              color="secondary"
              size="small">{$t('trash')}</Button
            >
          {/if}
        </nav>
      {/if}
    </div>
  </div>

  <div class="mb-4 flex flex-col">
    <Button
      class="m-1 mx-4 rounded-none rounded-b-3xl bg-white p-3 dark:bg-immich-dark-primary/10"
      href={Route.logout()}
      leadingIcon={mdiLogout}
      variant="ghost"
      color="secondary">{$t('sign_out')}</Button
    >

    <button
      type="button"
      class="mt-4 text-center text-xs text-primary underline"
      onclick={async () => {
        onClose?.();
        if (info) {
          await modalManager.show(HelpAndFeedbackModal, { info });
        }
      }}
    >
      {$t('support_and_feedback')}
    </button>
  </div>
</div>
