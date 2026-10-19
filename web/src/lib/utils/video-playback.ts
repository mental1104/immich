export const SMALL_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export function shouldPlaySmallVideoOriginal(fileSize: number | null | undefined, originalFailed: boolean) {
  return (
    !originalFailed && fileSize !== null && fileSize !== undefined && fileSize > 0 && fileSize <= SMALL_VIDEO_MAX_BYTES
  );
}
