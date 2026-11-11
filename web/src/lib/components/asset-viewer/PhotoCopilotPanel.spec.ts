import {
  listPhotoCopilotSessions,
  photoCopilotEventsUrl,
  requestPhotoCopilot,
  type PhotoCopilotSnapshot,
} from '#lib/services/photo-copilot.service.ts';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PhotoCopilotPanel from './PhotoCopilotPanel.svelte';

vi.mock('#lib/managers/auth-manager.svelte.ts', () => ({ authManager: { user: { id: 'synthetic-user' } } }));
vi.mock('#lib/services/photo-copilot.service.ts', () => ({
  listPhotoCopilotSessions: vi.fn(),
  requestPhotoCopilot: vi.fn(),
  photoCopilotEventsUrl: vi.fn(),
}));

/** 浏览器 SSE 替身，只模拟公开事件，断开后不会自动完成后台任务。 */
class TestEventSource extends EventTarget {
  static OPEN = 1;
  static instances: TestEventSource[] = [];
  readyState = 1;
  close = vi.fn();
  /** 记录新订阅，供测试从服务端侧投递流事件。 */
  constructor() {
    super();
    TestEventSource.instances.push(this);
  }
  /** @param state 后台快照；通过标准 message 事件发送。 */
  snapshot(state: PhotoCopilotSnapshot) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(state) }));
  }
}

/** @param assetId 合成照片 ID。@returns 无私人信息的独立测试会话快照。 */
function stateFor(assetId = 'asset-a'): PhotoCopilotSnapshot {
  return {
    id: `session-${assetId}`,
    assetId,
    fileName: `${assetId}.png`,
    context: { assetId },
    image: 'unavailable',
    status: 'idle',
    busy: false,
    error: null,
    messages: [],
  };
}

describe('PhotoCopilotPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionStorage.clear();
    TestEventSource.instances = [];
    vi.stubGlobal('EventSource', TestEventSource);
    vi.mocked(photoCopilotEventsUrl).mockReturnValue('/synthetic-events');
    vi.mocked(listPhotoCopilotSessions).mockResolvedValue([]);
    vi.mocked(requestPhotoCopilot).mockResolvedValue(stateFor());
    vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** 照片标识始终可见，流文本以纯文本呈现。 */
  it('opens, streams a reply and sends another message in the same session', async () => {
    await render(PhotoCopilotPanel, { assetId: 'asset-a', fileName: 'asset-a.png', onClose: vi.fn() });
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    const stream = TestEventSource.instances[0];
    stream.dispatchEvent(new Event('open'));
    await expect.element(page.getByTestId('copilot-asset-id')).toHaveTextContent('asset-a');
    await page.getByLabelText('Message about this photo').fill('Describe this');
    await page.getByRole('button', { name: 'Send' }).click();
    expect(requestPhotoCopilot).toHaveBeenCalledWith(
      'asset-a',
      'sessions/session-asset-a/messages',
      { message: 'Describe this' },
      expect.any(AbortSignal),
    );
    const state = stateFor();
    state.messages = [
      { id: 'question', role: 'user', text: 'Describe this' },
      { id: 'reply', role: 'assistant', text: '<script>safe text</script>' },
    ];
    stream.snapshot(state);
    await expect.element(page.getByText('<script>safe text</script>')).toBeInTheDocument();
    expect(document.querySelector('article script')).toBeNull();
    await page.getByLabelText('Message about this photo').fill('More detail');
    await page.getByRole('button', { name: 'Send' }).click();
    expect(requestPhotoCopilot).toHaveBeenLastCalledWith(
      'asset-a',
      'sessions/session-asset-a/messages',
      { message: 'More detail' },
      expect.any(AbortSignal),
    );
  });

  /** 停止是显式命令；关闭面板只断开流。 */
  it('stops explicitly and does not stop a task on close', async () => {
    const onClose = vi.fn();
    const view = await render(PhotoCopilotPanel, { assetId: 'asset-a', fileName: 'asset-a.png', onClose });
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    TestEventSource.instances[0].snapshot({ ...stateFor(), busy: true, status: 'running' });
    await page.getByRole('button', { name: 'Stop' }).click();
    expect(requestPhotoCopilot).toHaveBeenLastCalledWith(
      'asset-a',
      'sessions/session-asset-a/stop',
      {},
      expect.any(AbortSignal),
    );
    const count = vi.mocked(requestPhotoCopilot).mock.calls.length;
    await page.getByLabelText('Close Photo Copilot').click();
    expect(onClose).toHaveBeenCalledOnce();
    await view.unmount();
    expect(requestPhotoCopilot).toHaveBeenCalledTimes(count);
    expect(TestEventSource.instances[0].close).toHaveBeenCalled();
  });

  /** 模拟 keyed 父组件切图：旧流不能污染新照片，并能按照片恢复会话。 */
  it('keeps asset contexts separate and restores a saved session after remount', async () => {
    const first = await render(PhotoCopilotPanel, { assetId: 'asset-a', fileName: 'asset-a.png', onClose: vi.fn() });
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    await first.unmount();
    vi.mocked(requestPhotoCopilot).mockResolvedValue(stateFor('asset-b'));
    const second = await render(PhotoCopilotPanel, { assetId: 'asset-b', fileName: 'asset-b.png', onClose: vi.fn() });
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(2));
    TestEventSource.instances[0].snapshot({
      ...stateFor(),
      messages: [{ id: 'late', role: 'assistant', text: 'late answer from A' }],
    });
    await expect.element(page.getByText('late answer from A')).not.toBeInTheDocument();
    await expect.element(page.getByTestId('copilot-asset-id')).toHaveTextContent('asset-b');
    await second.unmount();
    vi.mocked(requestPhotoCopilot).mockResolvedValue(stateFor());
    await render(PhotoCopilotPanel, { assetId: 'asset-a', fileName: 'asset-a.png', onClose: vi.fn() });
    await vi.waitFor(() =>
      expect(requestPhotoCopilot).toHaveBeenLastCalledWith(
        'asset-a',
        'sessions',
        { sessionId: 'session-asset-a' },
        expect.any(AbortSignal),
      ),
    );
  });

  /** 连接故障提供可读错误和重连；服务重启后明确新建会话。 */
  it('reports an unavailable backend and recovers an expired session', async () => {
    vi.mocked(requestPhotoCopilot).mockRejectedValueOnce(new Error('Photo Copilot is disabled'));
    await render(PhotoCopilotPanel, { assetId: 'asset-a', fileName: 'asset-a.png', onClose: vi.fn() });
    await expect.element(page.getByRole('alert')).toHaveTextContent('Photo Copilot is disabled');
    await page.getByRole('button', { name: 'Reconnect' }).click();
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    TestEventSource.instances[0].dispatchEvent(new Event('error'));
    await expect.element(page.getByRole('status')).toHaveTextContent('Connection lost - reconnecting / idle');
  });

  /** 清空浏览器会话指针后仍可打开最近记录，再切换到同一照片的另一段对话。 */
  it('opens server history on a new browser and switches to an older conversation', async () => {
    const latest = {
      ...stateFor(),
      id: 'latest',
      messages: [{ id: 'question', role: 'user' as const, text: 'Explain the light' }],
    };
    const older = {
      ...stateFor(),
      id: 'older',
      messages: [{ id: 'other-question', role: 'user' as const, text: 'What time was this taken?' }],
    };
    vi.mocked(listPhotoCopilotSessions).mockResolvedValue([
      { id: 'latest', title: latest.messages[0].text },
      { id: 'older', title: older.messages[0].text },
    ]);
    vi.mocked(requestPhotoCopilot).mockResolvedValueOnce(latest).mockResolvedValueOnce(older);
    await render(PhotoCopilotPanel, { assetId: 'asset-a', fileName: 'asset-a.png', onClose: vi.fn() });
    await expect.element(page.getByRole('log')).toHaveTextContent('You Explain the light');
    expect(requestPhotoCopilot).toHaveBeenLastCalledWith(
      'asset-a',
      'sessions',
      { sessionId: 'latest' },
      expect.any(AbortSignal),
    );
    await page.getByRole('combobox').selectOptions('older');
    await expect.element(page.getByRole('log')).toHaveTextContent('You What time was this taken?');
    TestEventSource.instances[0].snapshot(latest);
    await expect.element(page.getByRole('log')).not.toHaveTextContent('You Explain the light');
  });
});
