import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import sharp from 'sharp';
import {
  createIphoneBackupRecovery,
  iphoneBackupImageExtension,
  iphoneBackupMetadataChecksum,
  restoreIphoneBackupImage,
} from 'src/utils/iphone-backup-image.js';
import { createSyntheticIphoneHeic } from 'test/fixtures/iphone-heic.fixture.js';

/** 验证保存小型元数据配方后仍可恢复完整原片，而不是仅仅恢复相似的像素。 */
describe('iPhone backup lossless metadata recovery', () => {
  let phone: Buffer;

  /** 生成无隐私、包含足够图像数据的合成 JPEG。 */
  beforeAll(async () => {
    const pixels = Buffer.alloc(64 * 64 * 3);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 37 + (index >> 5)) % 256;
    phone = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } })
      .jpeg()
      .toBuffer();
  });

  /** @param jpeg 原始 JPEG。@param text 本测试的 APP 元数据字节。@returns 不改变编码图像的独立文件缓冲区。 */
  function metadata(jpeg: Buffer, text: string): Buffer {
    const payload = Buffer.from(text);
    const marker = Buffer.alloc(4);
    marker.writeUInt16BE(0xff_e1);
    marker.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
  }

  /** 证明元数据布局可再次变化，而保存的手机版本仍能逐字节恢复。 */
  it('recovers the exact original after two independent metadata rewrites', () => {
    const source = metadata(phone, 'shared' + ' '.repeat(32_000));
    const recipe = createIphoneBackupRecovery(phone, source);
    expect(recipe.length).toBeLessThan(phone.length / 2);
    for (const current of [source, metadata(phone, 'shared and another layout')]) {
      const restored = restoreIphoneBackupImage(current, recipe);
      expect(restored).toEqual(phone);
      expect(createHash('sha1').update(restored).digest('hex')).toBe(createHash('sha1').update(phone).digest('hex'));
    }
  });

  /** 图像编码变化和损坏配方必须拒绝恢复，不能返回错误原片但仍声明原哈希。 */
  it('rejects changed image data and corrupt recovery records', async () => {
    const recipe = createIphoneBackupRecovery(phone, metadata(phone, 'shared'));
    const different = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#22aa33' } })
      .jpeg()
      .toBuffer();
    expect(() => createIphoneBackupRecovery(phone, different)).toThrow('image data differs');
    expect(() => restoreIphoneBackupImage(different, recipe)).toThrow('source image changed');
    const corrupt = Buffer.from(recipe);
    corrupt[corrupt.length - 5] ^= 0xff;
    expect(() => restoreIphoneBackupImage(phone, corrupt)).toThrow();
  });

  /** PNG 文本元数据和块 CRC 按原样恢复；真正的编码变化及非法块长度必须拒绝。 */
  it('recovers PNG text metadata and rejects changed image chunks', async () => {
    const png = await sharp(phone).png().toBuffer();
    const original = await sharp(phone)
      .withXmp(
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:description="phone"/></rdf:RDF></x:xmpmeta>',
      )
      .png()
      .toBuffer();
    const recipe = createIphoneBackupRecovery(original, png);
    expect(restoreIphoneBackupImage(png, recipe)).toEqual(original);
    const different = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#22aa33' } })
      .png()
      .toBuffer();
    expect(() => createIphoneBackupRecovery(original, different)).toThrow('image data differs');
    const malformed = Buffer.from(png);
    malformed.writeUInt32BE(0xff_ff_ff_ff, 8);
    expect(() => restoreIphoneBackupImage(malformed, recipe)).toThrow('Truncated backup PNG chunk');
  });

  /** HEIC 采用独立 v2 配方，地址表和 XMP 可变化，恢复结果必须仍是原编码及完整 SHA-1。 */
  it('uses a v2 HEIC recovery recipe and restores the exact original after XMP rewrites', () => {
    const original = createSyntheticIphoneHeic();
    const source = createSyntheticIphoneHeic('shared');
    const recipe = createIphoneBackupRecovery(original, source);
    const record = JSON.parse(gunzipSync(recipe).toString('utf8'));
    expect(record).toMatchObject({ version: 2, format: 'HEIC' });
    expect(iphoneBackupImageExtension(original)).toBe('heic');
    for (const current of [source, createSyntheticIphoneHeic('different labels and corrected metadata')]) {
      const restored = restoreIphoneBackupImage(current, recipe);
      expect(restored).toEqual(original);
      expect(createHash('sha1').update(restored).digest()).toEqual(createHash('sha1').update(original).digest());
      expect(restored.toString('ascii', 4, 8)).toBe('ftyp');
    }
  });

  /** 即使压缩图像载荷完全相同，HEVC 解码配置变化仍必须在创建和使用配方两端拒绝。 */
  it('rejects HEIC decoder configuration changes before create and restore', () => {
    const original = createSyntheticIphoneHeic();
    const source = createSyntheticIphoneHeic('shared');
    const recipe = createIphoneBackupRecovery(original, source);
    const changed = Buffer.from(source);
    const hvcc = changed.indexOf(Buffer.from('hvcC'));
    changed[hvcc + 5] ^= 1;
    expect(() => createIphoneBackupRecovery(original, changed)).toThrow('image data differs');
    expect(() => restoreIphoneBackupImage(changed, recipe)).toThrow('source image changed');
  });

  /** JPEG 与 HEIC 不跨编码合并，HEIC 配方版本不能降级伪装成旧版 JPEG/PNG 配方。 */
  it('rejects cross-format recovery and a downgraded HEIC recipe version', () => {
    const heic = createSyntheticIphoneHeic();
    expect(() => createIphoneBackupRecovery(phone, heic)).toThrow('image data differs');
    const recipe = createIphoneBackupRecovery(heic, createSyntheticIphoneHeic('shared'));
    const downgraded = JSON.parse(gunzipSync(recipe).toString('utf8'));
    downgraded.version = 1;
    const invalid = gzipSync(Buffer.from(JSON.stringify(downgraded)));
    expect(() => restoreIphoneBackupImage(heic, invalid)).toThrow('source image changed');
  });

  /** 诊断摘要区分实际字段变化；物理共用不要求此摘要相等，完整元数据另存于恢复配方。 */
  it('ignores only the verified shared tag differences', () => {
    const original = { 'EXIF:ExifIFD:ISO': 100, 'EXIF:IFD0:Orientation': 1 };
    const tagged = {
      ...original,
      'IPTC:Keywords': ['shared'],
      'XMP:XMP-dc:Subject': ['shared'],
      'XMP:XMP-x:XMPToolkit': 'writer',
    };
    expect(iphoneBackupMetadataChecksum(original)).toBe(iphoneBackupMetadataChecksum(tagged));
    for (const changed of [
      { ...tagged, 'IPTC:Keywords': ['shared', 'important'] },
      { ...tagged, 'EXIF:IFD0:Orientation': 3 },
      { ...tagged, 'EXIF:ExifIFD:ISO': 200 },
    ]) {
      expect(iphoneBackupMetadataChecksum(original)).not.toBe(iphoneBackupMetadataChecksum(changed));
    }
  });
});
