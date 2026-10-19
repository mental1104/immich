import { getAssetInfo } from '@immich/sdk';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import { assetFactory } from '@test-data/factories/asset-factory';
import VideoNativeViewer from './VideoNativeViewer.svelte';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { realtimeTranscoding: true } },
}));
vi.mock('$lib/managers/media-capabilities-manager.svelte', () => ({
  mediaCapabilitiesManager: { efficientLevels: vi.fn() },
}));
vi.mock('hls-video-element', () => ({}));
// 播放控件的 Shadow DOM 样式不由 happy-dom 支持，本测试只验证媒体源选择。
vi.mock('media-chrome/media-volume-range', () => ({}));
vi.mock('media-chrome/media-controller', () => ({}));
vi.mock('./immich-time-range', () => ({}));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAssetInfo: vi.fn(),
}));

describe('VideoNativeViewer small video playback', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', getResizeObserverMock());
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.mocked(getAssetInfo).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const mount = (asset = assetFactory.build({ exifInfo: { fileSizeInByte: 1024 } }), assetId = asset.id) =>
    render(VideoNativeViewer, {
      asset,
      assetId,
      loopVideo: true,
      cacheKey: null,
      playOriginalVideo: false,
    });

  it('requests the original directly and switches to HLS on a playback error', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    const video = container.querySelector('video')!;
    expect(video.getAttribute('src')).toContain('/original?');
    expect(video.getAttribute('src')).toContain('edited=false');
    expect(container.querySelector('hls-video')).toBeNull();

    await fireEvent.error(video);
    await waitFor(() => expect(container.querySelector('hls-video')).not.toBeNull());
    expect(container.querySelector('video')).toBeNull();
  });

  it('waits for the motion video size instead of using the still photo size', async () => {
    let resolveVideo!: (video: Awaited<ReturnType<typeof getAssetInfo>>) => void;
    vi.mocked(getAssetInfo).mockReturnValue(
      new Promise((resolve) => {
        resolveVideo = resolve;
      }),
    );
    const { container } = mount(undefined, 'motion-video');
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: 'motion-video' })));
    expect(container.querySelector('video, hls-video')).toBeNull();

    resolveVideo(assetFactory.build({ id: 'motion-video', exifInfo: { fileSizeInByte: 60 * 1024 * 1024 } }));
    await waitFor(() => expect(container.querySelector('hls-video')).not.toBeNull());
    expect(container.querySelector('video')).toBeNull();
  });

  it('falls back to HLS when the motion metadata request fails', async () => {
    vi.mocked(getAssetInfo).mockRejectedValue(new Error('Metadata unavailable'));
    const { container } = mount(undefined, 'motion-video');
    await waitFor(() => expect(container.querySelector('hls-video')).not.toBeNull());
  });

  it('uses the small motion video original even when the still photo exceeds the threshold', async () => {
    vi.mocked(getAssetInfo).mockResolvedValue(
      assetFactory.build({ id: 'motion-video', exifInfo: { fileSizeInByte: 1024 } }),
    );
    const photo = assetFactory.build({ exifInfo: { fileSizeInByte: 60 * 1024 * 1024 } });
    const { container } = mount(photo, 'motion-video');
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    expect(container.querySelector('video')!.getAttribute('src')).toContain('/assets/motion-video/original?');
    expect(container.querySelector('hls-video')).toBeNull();
  });
});
