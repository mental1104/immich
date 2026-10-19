import { vitest } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';

vitest.mock('src/constants', () => ({
  IWorker: 'IWorker',
}));

describe('StorageCore', () => {
  describe('getHlsSessionFolder', () => {
    const previousTempDir = process.env.IMMICH_HLS_TEMP_DIR;
    const ownerId = 'user-1';
    const sessionId = 'abcdef12-session';

    beforeEach(() => {
      StorageCore.setMediaLocation('/photos');
      delete process.env.IMMICH_HLS_TEMP_DIR;
    });

    afterEach(() => {
      if (previousTempDir === undefined) {
        delete process.env.IMMICH_HLS_TEMP_DIR;
      } else {
        process.env.IMMICH_HLS_TEMP_DIR = previousTempDir;
      }
    });

    it('keeps the original encoded-video layout by default', () => {
      expect(StorageCore.getHlsSessionFolder({ ownerId, sessionId })).toBe(
        '/photos/encoded-video/user-1/ab/cd/abcdef12-session',
      );
    });

    it('isolates short-lived HLS files under the optional SSD mount', () => {
      process.env.IMMICH_HLS_TEMP_DIR = '/data/hls-temp';
      expect(StorageCore.getHlsSessionFolder({ ownerId, sessionId })).toBe(
        '/data/hls-temp/user-1/ab/cd/abcdef12-session',
      );
      expect(StorageCore.getHlsVariantFolder({ ownerId, sessionId, variantIndex: 7 })).toBe(
        '/data/hls-temp/user-1/ab/cd/abcdef12-session/7',
      );
    });

    it('rejects a relative temporary directory', () => {
      process.env.IMMICH_HLS_TEMP_DIR = 'relative/hls';
      expect(() => StorageCore.getHlsSessionFolder({ ownerId, sessionId })).toThrow(
        'IMMICH_HLS_TEMP_DIR must be an absolute path',
      );
    });
  });

  describe('isImmichPath', () => {
    beforeAll(() => {
      StorageCore.setMediaLocation('/photos');
    });

    it('should return true for APP_MEDIA_LOCATION path', () => {
      const immichPath = '/photos';
      expect(StorageCore.isImmichPath(immichPath)).toBe(true);
    });

    it('should return true for paths within the APP_MEDIA_LOCATION', () => {
      const immichPath = '/photos/new/';
      expect(StorageCore.isImmichPath(immichPath)).toBe(true);
    });

    it('should return false for paths outside the APP_MEDIA_LOCATION and same starts', () => {
      const nonImmichPath = '/photos_new';
      expect(StorageCore.isImmichPath(nonImmichPath)).toBe(false);
    });

    it('should return false for paths outside the APP_MEDIA_LOCATION', () => {
      const nonImmichPath = '/some/other/path';
      expect(StorageCore.isImmichPath(nonImmichPath)).toBe(false);
    });
  });
});
