import { DateTime } from 'luxon';
import {
  getIphoneBackupConfig,
  getIphoneBackupPath,
  isIphoneBackupFingerprintingEnabled,
  isWithinDirectory,
  logIphoneBackupAudit,
} from 'src/utils/iphone-backup.js';

/** 验证用户提供的归档示例、拍摄时区和管理员配置边界。 */
describe('iPhone backup paths', () => {
  afterEach(() => vitest.unstubAllEnvs());

  it('preserves the original HEIC extension and capture time across server timezones', () => {
    const capturedAt = DateTime.fromISO('2026-11-03T11:10:00+08:00', { setZone: true });
    expect(getIphoneBackupPath('/photos/MobileBackup/iPhone', capturedAt, 'original.HEIC')).toBe(
      '/photos/MobileBackup/iPhone/2026/11/IMG_20261103_111000.HEIC',
    );
  });

  it('keeps JPEG and MOV extensions instead of canonicalizing them', () => {
    const capturedAt = DateTime.fromISO('2026-01-01T00:00:00-07:00', { setZone: true });
    expect(getIphoneBackupPath('/photos', capturedAt, 'image.JPEG')).toBe('/photos/2026/01/IMG_20260101_000000.JPEG');
    expect(getIphoneBackupPath('/photos', capturedAt, 'motion.MOV')).toBe('/photos/2026/01/IMG_20260101_000000.MOV');
  });

  it('does not enable backup unless a library is explicitly configured', () => {
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', '');
    expect(getIphoneBackupConfig()).toBeUndefined();
  });

  it('allows fingerprint scans to stay paused during sample preparation', () => {
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', '0b194880-6dca-44f4-a28d-9320d4841278');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', '/photos');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_FINGERPRINT_SCAN', 'false');
    expect(isIphoneBackupFingerprintingEnabled('0b194880-6dca-44f4-a28d-9320d4841278')).toBe(false);
  });

  it('rejects invalid library IDs, relative roots and invalid timezones', () => {
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', 'invalid');
    expect(() => getIphoneBackupConfig()).toThrow('Invalid iPhone backup configuration');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_LIBRARY_ID', '0b194880-6dca-44f4-a28d-9320d4841278');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', '../photos');
    expect(() => getIphoneBackupConfig()).toThrow('Invalid iPhone backup configuration');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_ROOT', '/photos');
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_TIME_ZONE', 'Invalid/Zone');
    expect(() => getIphoneBackupConfig()).toThrow('Invalid iPhone backup configuration');
  });

  it('rejects sibling paths that share the root prefix', () => {
    expect(isWithinDirectory('/photos', '/photos-other/2026')).toBe(false);
    expect(isWithinDirectory('/photos', '/photos/../private')).toBe(false);
    expect(isWithinDirectory('/photos', '/photos/2026')).toBe(true);
  });

  it('keeps audit logging disabled unless explicitly enabled', () => {
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_AUDIT', 'false');
    const logger = { log: vitest.fn() };
    logIphoneBackupAudit(logger, { event: 'upload_stream_started', uploadId: 'opaque-upload-id' });
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('emits a machine-readable audit event without changing the event data', () => {
    vitest.stubEnv('IMMICH_FORK_IPHONE_BACKUP_AUDIT', 'true');
    const logger = { log: vitest.fn() };
    const event = { event: 'upload_stream_failed', uploadId: 'opaque-upload-id', mediaBytes: 12 } as const;
    logIphoneBackupAudit(logger, event);
    expect(logger.log).toHaveBeenCalledExactlyOnceWith(`IphoneBackupAudit ${JSON.stringify(event)}`);
  });
});
