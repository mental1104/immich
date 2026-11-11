import { factory } from '#test/common/factories.ts';
import { getAssetInfo } from '@immich/sdk';
import { render } from 'vitest-browser-svelte';
import VideoNativeViewer from './VideoNativeViewer.svelte';

vi.mock('#lib/queries/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/queries/client.ts')>()),
  createPreloadedQuery: () => ({ data: { ffmpeg: { realtime: { enabled: true } } } }),
}));
vi.mock('#lib/managers/media-capabilities-manager.svelte.ts', () => ({
  mediaCapabilitiesManager: { efficientLevels: vi.fn() },
}));
vi.mock('hls-video-element', () => ({}));
// 将媒体控件替换为空实现，让测试只观察原片和 HLS 的选择。
vi.mock('media-chrome/media-volume-range', () => ({}));
vi.mock('media-chrome/media-controller', () => ({}));
vi.mock('./immich-time-range', () => ({}));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAssetInfo: vi.fn(),
}));

describe('VideoNativeViewer small video playback', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.mocked(getAssetInfo).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mount = (
    asset = factory.asset({ exifInfo: { fileSizeInByte: 1024 } }),
    assetId = asset.id,
    playOriginalVideo = false,
  ) =>
    render(VideoNativeViewer, {
      asset,
      assetId,
      loopVideo: true,
      cacheKey: null,
      playOriginalVideo,
    });

  it.each([undefined, 1024, 100 * 1024 * 1024])('honors explicit original playback for size %s', async (size) => {
    const asset = factory.asset({ exifInfo: { fileSizeInByte: size } });
    const { baseElement: container } = await mount(asset, asset.id, true);
    await vi.waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    const video = container.querySelector('video')!;
    expect(video.getAttribute('src')).toContain('/original?');
    expect(video.getAttribute('src')).toContain('edited=false');
    expect(container.querySelector('hls-video')).toBeNull();

    video.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('hls-video')).toBeNull();
    expect(video.getAttribute('src')).toContain('/original?');
  });

  it('allows manually switching to HLS after an explicit original error', async () => {
    const asset = factory.asset({ exifInfo: { fileSizeInByte: 100 * 1024 * 1024 } });
    const view = await mount(asset, asset.id, true);
    await vi.waitFor(() => expect(view.baseElement.querySelector('video')).not.toBeNull());
    view.baseElement.querySelector('video')!.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(view.baseElement.querySelector('[role="alert"]')).not.toBeNull());

    await view.rerender({ playOriginalVideo: false });
    await vi.waitFor(() => expect(view.baseElement.querySelector('hls-video')).not.toBeNull());
    expect(view.baseElement.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not request motion metadata in explicit original mode', async () => {
    const { baseElement: container } = await mount(undefined, 'motion-video', true);
    await vi.waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    expect(getAssetInfo).not.toHaveBeenCalled();
    expect(container.querySelector('video')!.getAttribute('src')).toContain('/assets/motion-video/original?');
  });

  it('requests the original directly and switches to HLS on a playback error', async () => {
    const { baseElement: container } = await mount();
    await vi.waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    const video = container.querySelector('video')!;
    expect(video.getAttribute('src')).toContain('/original?');
    expect(video.getAttribute('src')).toContain('edited=false');
    expect(container.querySelector('hls-video')).toBeNull();

    video.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(container.querySelector('hls-video')).not.toBeNull());
    expect(container.querySelector('video')).toBeNull();
  });

  it('waits for the motion video size instead of using the still photo size', async () => {
    let resolveVideo!: (video: Awaited<ReturnType<typeof getAssetInfo>>) => void;
    vi.mocked(getAssetInfo).mockReturnValue(
      new Promise((resolve) => {
        resolveVideo = resolve;
      }),
    );
    const { baseElement: container } = await mount(undefined, 'motion-video');
    await vi.waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: 'motion-video' })));
    expect(container.querySelector('video, hls-video')).toBeNull();

    resolveVideo(factory.asset({ id: 'motion-video', exifInfo: { fileSizeInByte: 60 * 1024 * 1024 } }));
    await vi.waitFor(() => expect(container.querySelector('hls-video')).not.toBeNull());
    expect(container.querySelector('video')).toBeNull();
  });

  it('falls back to HLS when the motion metadata request fails', async () => {
    vi.mocked(getAssetInfo).mockRejectedValue(new Error('Metadata unavailable'));
    const { baseElement: container } = await mount(undefined, 'motion-video');
    await vi.waitFor(() => expect(container.querySelector('hls-video')).not.toBeNull());
  });

  it('uses the small motion video original even when the still photo exceeds the threshold', async () => {
    vi.mocked(getAssetInfo).mockResolvedValue(
      factory.asset({ id: 'motion-video', exifInfo: { fileSizeInByte: 1024 } }),
    );
    const photo = factory.asset({ exifInfo: { fileSizeInByte: 60 * 1024 * 1024 } });
    const { baseElement: container } = await mount(photo, 'motion-video');
    await vi.waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    expect(container.querySelector('video')!.getAttribute('src')).toContain('/assets/motion-video/original?');
    expect(container.querySelector('hls-video')).toBeNull();
  });
});
