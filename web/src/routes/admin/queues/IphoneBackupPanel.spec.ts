import '@testing-library/jest-dom';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import type { IphoneBackupProgress } from '$lib/services/iphone-backup.service';
import IphoneBackupPanel from './IphoneBackupPanel.svelte';

/** 验证进度含义与控制按钮，避免空队列被误报为准备完成或页面自动触发任务。 */
describe('iPhone backup progress panel', () => {
  /** 采用真实英文翻译，以便断言用户看到的完成数、剩余数和动作。 */
  beforeAll(async () => {
    register('en-US', () => import('$i18n/en.json'));
    await init({ fallbackLocale: 'en-US', initialLocale: 'en-US' });
    await waitLocale('en-US');
  });

  afterEach(cleanup);

  const progress: IphoneBackupProgress = {
    enabled: true,
    uploadsEnabled: false,
    total: 162_662,
    ready: 24,
    pending: 162_638,
    state: 'idle',
    batch: null,
  };

  it('shows database progress and waits for an explicit batch action', async () => {
    const oncommand = vi.fn();
    const view = render(IphoneBackupPanel, { progress, busy: false, stale: false, oncommand });
    expect(view.getByText(/Ready 24 \/ 162,662; remaining 162,638/)).toBeInTheDocument();
    expect(view.getByText(/Phone uploads are paused/)).toBeInTheDocument();
    expect(oncommand).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Process next batch' }));
    expect(oncommand).toHaveBeenCalledWith('start');
  });

  it('offers explicit resume for a paused batch', async () => {
    const oncommand = vi.fn();
    const view = render(IphoneBackupPanel, {
      progress: { ...progress, state: 'paused' },
      busy: false,
      stale: false,
      oncommand,
    });
    await fireEvent.click(view.getByRole('button', { name: 'Process next batch' }));
    expect(oncommand).toHaveBeenCalledWith('resume');
  });

  it('keeps failures visible and requires explicit retry', async () => {
    const oncommand = vi.fn();
    const view = render(IphoneBackupPanel, {
      progress: {
        ...progress,
        state: 'failed',
        batch: { completed: 0, bytes: 0, errorCode: 'ENOENT', currentAssetId: 'opaque-asset-id' },
      },
      busy: false,
      stale: false,
      oncommand,
    });
    expect(view.getByRole('alert')).toHaveTextContent('ENOENT opaque-asset-id');
    expect(view.getByRole('button', { name: 'Process next batch' })).toBeDisabled();
    await fireEvent.click(view.getByRole('button', { name: 'Retry failed batch' }));
    expect(oncommand).toHaveBeenCalledWith('retry');
  });

  it('marks stale data and prevents controls from submitting against it', () => {
    const view = render(IphoneBackupPanel, { progress, busy: false, stale: true, oncommand: vi.fn() });
    expect(view.getByRole('alert')).toHaveTextContent(/progress may be out of date/);
    expect(view.getByRole('button', { name: 'Process next batch' })).toBeDisabled();
  });
});
