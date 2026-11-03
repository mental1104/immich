import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { requestIphoneBackupProgress } from '$lib/services/iphone-backup.service';

/** 验证管理页默认批量与服务端新契约一致，避免界面仍提交旧的 1000 上限。 */
describe('fingerprint preparation requests', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    sdkMock.getBaseUrl.mockReturnValue('/api');
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: () => Promise.resolve({ enabled: true }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('submits a 5000-file continuous batch with the existing login cookie', async () => {
    await requestIphoneBackupProgress('continue');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/fork/iphone-backup',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        body: JSON.stringify({ command: 'continue', limit: 5000 }),
      }),
    );
  });

  it('refreshes status without starting any work', async () => {
    await requestIphoneBackupProgress();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/fork/iphone-backup',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        body: undefined,
      }),
    );
  });
});
