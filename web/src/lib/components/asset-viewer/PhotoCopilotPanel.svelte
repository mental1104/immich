<script lang="ts">
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import {
    listPhotoCopilotSessions,
    photoCopilotEventsUrl,
    requestPhotoCopilot,
    type PhotoCopilotSessionSummary,
    type PhotoCopilotSnapshot,
  } from '#lib/services/photo-copilot.service.ts';
  import { onMount } from 'svelte';

  /** 当前照片的聊天内容；AI 面板以 Asset ID 为 key 重建，隔离会话与订阅。 */
  interface Props {
    assetId: string;
  }
  let { assetId }: Props = $props();
  let snapshot = $state<PhotoCopilotSnapshot>();
  let history = $state<PhotoCopilotSessionSummary[]>([]);
  let input = $state('');
  let error = $state<string | null>(null);
  let connection = $state('Connecting');
  let opening = $state(false);
  let submitting = $state(false);
  let transcript = $state<HTMLDivElement>();
  let stream: EventSource | undefined;
  const controller = new AbortController();
  const storageKey = `photo-copilot:${authManager.user.id}:${assetId}`;

  /** @param state 后台快照；只接收本照片，并让滚动跟随最新输出。 */
  function accept(state: PhotoCopilotSnapshot) {
    if (state.assetId !== assetId || controller.signal.aborted) return;
    snapshot = state;
    error = state.error;
    if (state.messages.length > 0 && history.every(({ id }) => id !== state.id)) {
      history = [{ id: state.id, title: state.messages[0].text.slice(0, 100) }, ...history];
    }
    requestAnimationFrame(() => transcript?.scrollTo({ top: transcript.scrollHeight, behavior: 'instant' }));
  }

  /** @param id 已创建会话；断线后浏览器自动重连，服务端立即提供完整快照。 */
  function subscribe(id: string) {
    stream?.close();
    const source = new EventSource(photoCopilotEventsUrl(assetId, id), { withCredentials: true });
    stream = source;
    source.addEventListener('open', () => {
      if (stream !== source) return;
      connection = 'Connected';
    });
    source.addEventListener('message', (event) => {
      if (stream !== source) return;
      try {
        const state = JSON.parse(event.data);
        if (!state.heartbeat && state.id === id) accept(state);
      } catch {
        error = 'Invalid response from Photo Copilot';
      }
    });
    source.addEventListener('error', () => {
      if (stream !== source) return;
      connection = 'Connection lost - reconnecting';
    });
  }

  /**
   * 优先恢复显式选择或本标签页的会话，新标签页默认打开最近的历史。
   * @param fresh 为 true 时创建空会话。@param selected 用户选中的历史会话 ID。
   */
  async function open(fresh = false, selected?: string) {
    if (opening) return;
    opening = true;
    connection = 'Connecting';
    error = null;
    stream?.close();
    stream = undefined;
    try {
      history = await listPhotoCopilotSessions(assetId, controller.signal);
      const id = fresh ? null : selected || sessionStorage.getItem(storageKey) || history[0]?.id;
      let state: PhotoCopilotSnapshot;
      try {
        state = await requestPhotoCopilot(assetId, 'sessions', id ? { sessionId: id } : {}, controller.signal);
      } catch (error_) {
        // 旧版内存会话重启后可能已不存在；尝试当前照片最新的已保存会话。
        if (!(error_ instanceof Error && 'status' in error_ && error_.status === 404) || !id) throw error_;
        history = history.filter((item) => item.id !== id);
        const latest = history[0]?.id;
        state = await requestPhotoCopilot(assetId, 'sessions', latest ? { sessionId: latest } : {}, controller.signal);
      }
      if (controller.signal.aborted) return;
      accept(state);
      sessionStorage.setItem(storageKey, state.id);
      subscribe(state.id);
    } catch (error_) {
      if (!controller.signal.aborted) {
        snapshot = undefined;
        error = error_ instanceof Error ? error_.message : 'Photo Copilot is unavailable';
        connection = 'Unavailable';
      }
    } finally {
      opening = false;
    }
  }

  /** @param event 表单提交事件；一次只提交一条消息，输入在后台受理后清空。 */
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (!snapshot || snapshot.busy || submitting || !input.trim()) return;
    submitting = true;
    error = null;
    const message = input;
    try {
      const state = await requestPhotoCopilot(
        assetId,
        `sessions/${snapshot.id}/messages`,
        { message },
        controller.signal,
      );
      // SSE 可能先于 HTTP 响应完成；只用流更新，避免旧的受理状态覆盖较新的终态。
      if (stream?.readyState !== EventSource.OPEN) accept(state);
      input = '';
    } catch (error_) {
      if (!controller.signal.aborted) error = error_ instanceof Error ? error_.message : 'Message failed';
    } finally {
      submitting = false;
    }
  }

  /** 显式停止当前照片任务；按钮不会将停止请求受理误写成任务完成。 */
  async function stop() {
    if (!snapshot) return;
    try {
      await requestPhotoCopilot(assetId, `sessions/${snapshot.id}/stop`, {}, controller.signal);
    } catch (error_) {
      if (!controller.signal.aborted) error = error_ instanceof Error ? error_.message : 'Stop failed';
    }
  }

  onMount(() => {
    void open();
    // 关闭和切图仅结束观察；任务继续在 NAS 后台运行，重新打开可恢复。
    return () => {
      controller.abort();
      stream?.close();
    };
  });
</script>

<div class="copilot-chat" data-testid="photo-copilot-panel">
  <div class="context">
    <small data-testid="copilot-asset-id">{assetId}</small>
    <small role="status">{connection} {snapshot ? ` / ${snapshot.status}` : ''}</small>
    <small
      >Image: {snapshot?.image === 'original'
        ? 'original photo'
        : snapshot?.image === 'converted'
          ? 'locally converted HEIC'
          : snapshot?.image === 'embedded-preview'
            ? 'RAW embedded preview'
            : snapshot?.image === 'preview'
              ? 'Immich preview'
              : 'not attached'}</small
    >
    <p>Chats are saved in Immich. Images and context are sent to the server's Codex model provider.</p>
    {#if snapshot}
      <details>
        <summary>Photo context</summary>
        <pre>{JSON.stringify(snapshot.context, null, 2)}</pre>
      </details>
    {/if}
  </div>
  <div class="messages" bind:this={transcript} role="log" aria-label="Conversation">
    {#if !snapshot?.messages.length}<p>Ask about this photo, its camera settings, or possible improvements.</p>{/if}
    {#each snapshot?.messages ?? [] as message (message.id)}
      <article class:user={message.role === 'user'}>
        <small>{message.role === 'user' ? 'You' : 'Codex'}</small>
        <div>{message.text}</div>
      </article>
    {/each}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <form onsubmit={send}>
    {#if history.length}
      <label class="history">
        History
        <select
          value={snapshot?.id ?? ''}
          disabled={opening || submitting}
          onchange={(event) => open(false, event.currentTarget.value)}
        >
          {#if history.every(({ id }) => id !== snapshot?.id)}
            <option value="" disabled>New conversation</option>
          {/if}
          {#each history as session (session.id)}
            <option value={session.id}>{session.title}</option>
          {/each}
        </select>
      </label>
    {/if}
    <label for="photo-copilot-message">Message about this photo</label>
    <textarea
      id="photo-copilot-message"
      bind:value={input}
      rows="3"
      maxlength="16000"
      placeholder="What can you tell me about this photo?"
      disabled={!snapshot || opening}></textarea>
    <div class="actions">
      <button type="button" onclick={() => open(true)} disabled={opening || snapshot?.busy || submitting}
        >New session</button
      >
      {#if connection !== 'Connected'}<button type="button" onclick={() => open()} disabled={opening}>Reconnect</button
        >{/if}
      {#if snapshot?.busy || submitting}<button
          type="button"
          onclick={stop}
          disabled={opening || !snapshot?.busy || snapshot?.status === 'stopping'}>Stop</button
        >
      {:else}<button class="send" type="submit" disabled={!snapshot || !input.trim() || opening}>Send</button>{/if}
    </div>
  </form>
</div>

<style>
  .copilot-chat {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    font:
      14px/1.5 system-ui,
      sans-serif;
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  form,
  .context {
    padding: 12px 16px;
  }
  button {
    cursor: pointer;
    border: 1px solid #626777;
    border-radius: 8px;
    padding: 6px 10px;
    background: transparent;
    color: inherit;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .send {
    background: #4250af;
  }
  .context {
    border-bottom: 1px solid #4b4d58;
  }
  small {
    display: block;
    overflow-wrap: anywhere;
  }
  small,
  .context p {
    color: #b8bed1;
    font-size: 12px;
  }
  p {
    margin: 6px 0;
  }
  pre {
    max-height: 160px;
    overflow: auto;
    font-size: 11px;
    white-space: pre-wrap;
  }
  .messages {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 16px;
  }
  article {
    padding: 10px;
    margin-bottom: 12px;
    border-radius: 8px;
    background: #252936;
  }
  article.user {
    background: #303b5c;
  }
  article div {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  form {
    border-top: 1px solid #4b4d58;
  }
  .history {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  select {
    min-width: 0;
    width: 100%;
    border: 1px solid #626777;
    border-radius: 8px;
    background: #252936;
    color: inherit;
    padding: 6px;
  }
  textarea {
    display: block;
    box-sizing: border-box;
    width: 100%;
    resize: vertical;
    margin: 8px 0;
    border: 1px solid #626777;
    border-radius: 8px;
    background: #252936;
    color: inherit;
    padding: 8px;
    font: inherit;
  }
  .error {
    padding: 8px 16px;
    color: #ffb5b5;
    overflow-wrap: anywhere;
  }
</style>
