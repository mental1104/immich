import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  UnsupportedIphoneBackupHeifError,
  inspectIphoneBackupHeif,
  isIphoneBackupHeif,
} from 'src/utils/iphone-backup-heif.js';
import { createIphoneBackupRecovery, restoreIphoneBackupImage } from 'src/utils/iphone-backup-image.js';
import { createSyntheticIphoneHeic } from 'test/fixtures/iphone-heic.fixture.js';

/** 测试专属盒位置，所有载荷均来自合成 HEVC，不包含私人照片。 */
interface TestBox {
  type: string;
  start: number;
  data: number;
  end: number;
  raw: Buffer;
}
/** 仅测试需要的静态容器布局、辅助图及可变元数据。 */
interface Layout {
  exif?: string;
  xmp?: string;
  auxiliary?: Buffer;
  idat?: boolean;
  toneMap?: boolean;
  reverse?: boolean;
  /** 同实际 iPhone 文件加入已注册的 MiPr 兼容品牌，不引入未知盒或编码。 */
  progressive?: boolean;
}

/** @param value 测试整数。@param width 字节宽度。@returns 大端整数。 */
function uint(value: number, width = 4): Buffer {
  const bytes = Buffer.alloc(width);
  bytes.writeUIntBE(value, 0, width);
  return bytes;
}
/** @param type ISO 盒类型。@param parts 原样子片段。@returns 测试盒及准确长度。 */
function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([uint(body.length + 8), Buffer.from(type), body]);
}
/** @param version FullBox 版本。@param flags 标志。@returns 四字节头。 */
function full(version = 0, flags = 0): Buffer {
  return Buffer.concat([uint(version, 1), uint(flags, 3)]);
}
/** @param bytes 合成文件。@param start 直接子盒起点。@param end 直接子盒终点。@returns 测试构造器已知正确的盒位置。 */
function boxes(bytes: Buffer, start = 0, end = bytes.length): TestBox[] {
  const output: TestBox[] = [];
  while (start < end) {
    const length = bytes.readUInt32BE(start);
    output.push({
      type: bytes.toString('ascii', start + 4, start + 8),
      start,
      data: start + 8,
      end: start + length,
      raw: bytes.subarray(start, start + length),
    });
    start += length;
  }
  return output;
}
/** @param bytes 合成文件。@param type 唯一盒名。@returns 用于定点破坏格式的盒位置。 */
function locate(bytes: Buffer, type: string): number {
  const position = bytes.indexOf(Buffer.from(type));
  if (position < 4) throw new Error('Missing synthetic box');
  return position - 4;
}
/** @param bytes 完整已支持文件。@returns 按物理顺序保留的全部非元数据载荷。 */
function core(bytes: Buffer): Buffer {
  return Buffer.concat(
    inspectIphoneBackupHeif(bytes)
      .pieces.filter((piece) => !piece.metadata)
      .map((piece) => piece.bytes),
  );
}

/**
 * 构造包含实际合成 HEVC 配置与帧、辅助图、idat、Exif/XMP、altr/tmap 的结构测试文件。
 * @param options 有界测试布局。@returns 精确 iloc 地址的独立文件，供结构及逐字节恢复契约测试。
 */
function layout(options: Layout = {}): Buffer {
  const original = createSyntheticIphoneHeic();
  const top = boxes(original),
    meta = top.find((part) => part.type === 'meta')!;
  const children = boxes(original, meta.data + 4, meta.end);
  const originalFtyp = top.find((part) => part.type === 'ftyp')!.raw;
  const ftyp = options.progressive ? box('ftyp', originalFtyp.subarray(8), Buffer.from('MiPr')) : originalFtyp;
  const hdlr = children.find((part) => part.type === 'hdlr')!.raw;
  const properties = children.find((part) => part.type === 'iprp')!;
  const ipco = boxes(original, properties.data, properties.end).find((part) => part.type === 'ipco')!.raw;
  const frame = top.find((part) => part.type === 'mdat')!;
  const image = original.subarray(frame.data, frame.end);
  const items = [
    { id: 1, type: 'hvc1', bytes: image, metadata: false },
    ...(options.auxiliary ? [{ id: 2, type: 'hvc1', bytes: options.auxiliary, metadata: false }] : []),
    ...(options.exif === undefined ? [] : [{ id: 3, type: 'Exif', bytes: Buffer.from(options.exif), metadata: true }]),
    ...(options.xmp === undefined ? [] : [{ id: 4, type: 'mime', bytes: Buffer.from(options.xmp), metadata: true }]),
    ...(options.toneMap ? [{ id: 5, type: 'tmap', bytes: Buffer.from('tone-map-data'), metadata: false }] : []),
  ];
  const iinf = box(
    'iinf',
    full(),
    uint(items.length, 2),
    ...items.map((item) =>
      box(
        'infe',
        full(2),
        uint(item.id, 2),
        uint(0, 2),
        Buffer.from(`${item.type}\0${item.type === 'mime' ? 'application/rdf+xml\0\0' : ''}`),
      ),
    ),
  );
  const associations = items
    .filter((item) => !item.metadata)
    .map((item) =>
      Buffer.concat([
        uint(item.id, 2),
        item.type === 'hvc1' ? Buffer.from([4, 0x81, 0x82, 0x83, 4]) : Buffer.from([1, 0x82]),
      ]),
    );
  const iprp = box('iprp', ipco, box('ipma', full(), uint(associations.length), ...associations));
  const refs = items
    .filter((item) => item.metadata)
    .map((item) => box('cdsc', uint(item.id, 2), uint(1, 2), uint(1, 2)));
  if (options.auxiliary) refs.push(box('auxl', uint(2, 2), uint(1, 2), uint(1, 2)));
  if (options.toneMap)
    refs.push(
      box(
        'dimg',
        uint(5, 2),
        uint(options.auxiliary ? 2 : 1, 2),
        uint(1, 2),
        ...(options.auxiliary ? [uint(2, 2)] : []),
      ),
    );
  const iref = box('iref', full(), ...refs);
  const pitm = box('pitm', full(), uint(options.toneMap ? 5 : 1, 2));
  const dinf = box('dinf', box('dref', full(), uint(1), box('url ', full(0, 1))));
  const grpl = options.auxiliary ? box('grpl', box('altr', full(), uint(59), uint(2), uint(1), uint(2))) : undefined;
  const physical = options.reverse ? items.toReversed() : items;
  const internal = options.idat ? items[0] : undefined;
  const media = physical.filter((item) => item !== internal);
  const idat = internal ? box('idat', internal.bytes) : undefined;
  /** @param offset mdat 起点。@returns iloc1，图像可选择相对 idat 地址；其他条目使用绝对 mdat 地址。 */
  function iloc(offset: number): Buffer {
    return box(
      'iloc',
      full(1),
      Buffer.from([0x44, 0]),
      uint(items.length, 2),
      ...items.map((item) => {
        const before = media.slice(0, media.indexOf(item)).reduce((total, entry) => total + entry.bytes.length, 0);
        return Buffer.concat([
          uint(item.id, 2),
          uint(item === internal ? 1 : 0, 2),
          uint(0, 2),
          uint(1, 2),
          uint(item === internal ? 0 : offset + before),
          uint(item.bytes.length),
        ]);
      }),
    );
  }
  /** @param offset mdat 实际载荷位置。@returns 除地址之外长度固定的 meta。 */
  function metadata(offset: number): Buffer {
    return box(
      'meta',
      full(),
      hdlr,
      dinf,
      pitm,
      iinf,
      iref,
      iprp,
      ...(grpl ? [grpl] : []),
      ...(idat ? [idat] : []),
      iloc(offset),
    );
  }
  const provisional = metadata(0);
  return Buffer.concat([
    ftyp,
    metadata(ftyp.length + provisional.length + 8),
    box('mdat', ...media.map((item) => item.bytes)),
  ]);
}

/** 解析器仅忽略明确 Exif/XMP，解码配置、辅助图、引用及每一处物理字节均有验证。 */
describe('strict iPhone HEIF structure', () => {
  /** 真实可解码的合成 HEVC 以及新增 XMP 元数据具有相同全部图像载荷和不变量。 */
  it('recognizes synthetic HEIC and ignores only its added XMP item', () => {
    const original = createSyntheticIphoneHeic(),
      tagged = createSyntheticIphoneHeic('shared');
    expect(isIphoneBackupHeif(original)).toBe(true);
    expect(inspectIphoneBackupHeif(tagged).fingerprint).toBe(inspectIphoneBackupHeif(original).fingerprint);
    expect(core(tagged)).toEqual(core(original));
    expect(tagged).not.toEqual(original);
  });

  /** 实际 iPhone 的 MiPr 品牌可包含 HDR/辅助图；元数据变化仍以 v2 配方恢复完整手机字节。 */
  it('accepts registered MiPr with HDR items and restores the complete v2 original', () => {
    const original = layout({
      progressive: true,
      idat: true,
      toneMap: true,
      auxiliary: Buffer.from('gain-map-frame'),
      exif: 'original camera time and GPS',
      xmp: '<xmp>original tags</xmp>',
    });
    const tagged = layout({
      progressive: true,
      idat: true,
      toneMap: true,
      auxiliary: Buffer.from('gain-map-frame'),
      exif: 'corrected camera time and added GPS coordinates',
      xmp: '<xmp>shared tag</xmp>',
    });
    expect(inspectIphoneBackupHeif(original).fingerprint).toBe(inspectIphoneBackupHeif(tagged).fingerprint);
    const recipe = createIphoneBackupRecovery(original, tagged);
    expect(JSON.parse(gunzipSync(recipe).toString('utf8'))).toMatchObject({ version: 2, format: 'HEIC' });
    const restored = restoreIphoneBackupImage(tagged, recipe);
    expect(restored).toEqual(original);
    expect(createHash('sha1').update(restored).digest()).toEqual(createHash('sha1').update(original).digest());
  });

  /** 接受 MiPr 不放宽编码/辅助图保护；即使主图仍相同，修改任一项都不能共享恢复资料。 */
  it.each(['hvcC', 'auxiliary'])('protects changed %s in a MiPr image', (type) => {
    const original = layout({ progressive: true, auxiliary: Buffer.from('gain-map-frame'), toneMap: true });
    const changed =
      type === 'auxiliary'
        ? layout({ progressive: true, auxiliary: Buffer.from('GAIN-map-frame'), toneMap: true })
        : Buffer.from(original);
    if (type === 'hvcC') changed[locate(changed, 'hvcC') + 9] ^= 1;
    expect(inspectIphoneBackupHeif(changed).fingerprint).not.toBe(inspectIphoneBackupHeif(original).fingerprint);
    expect(() => createIphoneBackupRecovery(original, changed)).toThrow('Recovery image data differs');
  });

  /** 已知 MiPr 不授权其他未知兼容品牌；不能仅凭主品牌 heic 忽略额外语义。 */
  it('still rejects an unknown compatible brand alongside known HEIC structure', () => {
    const unknown = layout({ progressive: true });
    const ftyp = locate(unknown, 'ftyp');
    unknown.write('zzzz', ftyp + unknown.readUInt32BE(ftyp) - 4, 'ascii');
    expect(() => inspectIphoneBackupHeif(unknown)).toThrow(UnsupportedIphoneBackupHeifError);
  });

  /** 改变地址、长度以及两种明确元数据载荷后，全部物理分段仍可逐字节重建手机版本。 */
  it.each([false, true])('partitions every byte and recovers metadata edits with idat=%s', (idat) => {
    const original = layout({
      idat,
      exif: 'original-exif',
      xmp: '<xmp>original</xmp>',
      auxiliary: Buffer.from('gain-map-frame'),
      toneMap: true,
    });
    const edited = layout({
      idat,
      exif: 'changed GPS/time/EXIF longer',
      xmp: '<xmp>different tags</xmp>',
      auxiliary: Buffer.from('gain-map-frame'),
      toneMap: true,
    });
    const a = inspectIphoneBackupHeif(original),
      b = inspectIphoneBackupHeif(edited);
    expect(Buffer.concat(a.pieces.map((piece) => piece.bytes))).toEqual(original);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(core(original)).toEqual(core(edited));
    const source = core(edited);
    let offset = 0;
    const restored = Buffer.concat(
      a.pieces.map((piece) => {
        if (piece.metadata) return piece.bytes;
        const bytes = source.subarray(offset, offset + piece.bytes.length);
        offset += piece.bytes.length;
        return bytes;
      }),
    );
    expect(restored).toEqual(original);
    expect(createHash('sha1').update(restored).digest()).toEqual(createHash('sha1').update(original).digest());
  });

  /** HEVC 参数、颜色、像素位深与属性关联都属于解码身份，不能作为照片标签忽略。 */
  it.each(['hvcC', 'colr', 'pixi', 'ispe', 'ipma'])('does not merge changed %s decoding invariants', (type) => {
    const original = layout();
    const changed = Buffer.from(original);
    const position = locate(changed, type);
    if (type === 'hvcC') changed[position + 9] ^= 1;
    else if (type === 'ipma') changed[position + 21] ^= 0x80;
    else changed[position + changed.readUInt32BE(position) - 1] ^= type === 'colr' ? 0x80 : 1;
    expect(inspectIphoneBackupHeif(changed).fingerprint).not.toBe(inspectIphoneBackupHeif(original).fingerprint);
  });

  /** 辅助图载荷、图像引用关系和主图身份改变，即使主 HEVC 字节相同也不能匹配。 */
  it('protects auxiliary payloads, references, groups and the primary item', () => {
    const original = layout({ auxiliary: Buffer.from('gain-map-frame'), toneMap: true });
    const different = layout({ auxiliary: Buffer.from('GAIN-map-frame'), toneMap: true });
    expect(inspectIphoneBackupHeif(different).fingerprint).not.toBe(inspectIphoneBackupHeif(original).fingerprint);
    for (const type of ['auxl', 'pitm', 'altr']) {
      const changed = Buffer.from(original);
      const position = locate(changed, type);
      switch (type) {
        case 'auxl': {
          changed.writeUInt16BE(5, position + 12);
          break;
        }
        case 'pitm': {
          changed.writeUInt16BE(1, position + 12);
          break;
        }
        case 'altr': {
          changed.writeUInt32BE(5, position + 20);
          // No default
          break;
        }
      }
      expect(inspectIphoneBackupHeif(changed).fingerprint).not.toBe(inspectIphoneBackupHeif(original).fingerprint);
    }
  });

  /** 相同逻辑图像的载荷物理顺序不同仍采用保守拒绝，确保旧配方的顺序复制永不串图。 */
  it('keeps the physical order of every common payload in the fingerprint', () => {
    const original = layout({ auxiliary: Buffer.from('second-image') });
    const reversed = layout({ auxiliary: Buffer.from('second-image'), reverse: true });
    expect(inspectIphoneBackupHeif(original).fingerprint).not.toBe(inspectIphoneBackupHeif(reversed).fingerprint);
  });

  /** 未知盒、属性或编码不是可忽略元数据；异常类型明确支持完整文件回退。 */
  it.each(['hvcC', 'hvc1', 'auxl', 'altr'])('rejects unknown replacement for %s', (type) => {
    const changed = layout({ auxiliary: Buffer.from('aux-image') });
    changed.write('zzzz', locate(changed, type) + 4, 'ascii');
    expect(() => inspectIphoneBackupHeif(changed)).toThrow(UnsupportedIphoneBackupHeifError);
  });

  /** 截断、盒越界及未知顶层盒全部拒绝，不能由 Buffer 截断行为掩盖。 */
  it('rejects truncated, oversized and unknown boxes', () => {
    const original = layout();
    for (const bytes of [original.subarray(0, -1), Buffer.concat([original, box('uuid', Buffer.alloc(16))])])
      expect(() => inspectIphoneBackupHeif(bytes)).toThrow(UnsupportedIphoneBackupHeifError);
    const changed = Buffer.from(original);
    changed.writeUInt32BE(0xff_ff_ff_fe, locate(changed, 'meta'));
    expect(() => inspectIphoneBackupHeif(changed)).toThrow(UnsupportedIphoneBackupHeifError);
  });

  /** 外部引用、条目构造方式和越界范围都不满足本地完整文件证明。 */
  it.each(['external', 'method2', 'out-of-bounds', 'overlap', 'zero-length'])('rejects %s extents', (mode) => {
    const changed = layout({ auxiliary: Buffer.from('aux-image') });
    const location = locate(changed, 'iloc');
    switch (mode) {
      case 'external': {
        changed.writeUInt16BE(1, location + 20);
        break;
      }
      case 'method2': {
        changed.writeUInt16BE(2, location + 18);
        break;
      }
      case 'out-of-bounds': {
        changed.writeUInt32BE(changed.length, location + 24);
        break;
      }
      case 'zero-length': {
        changed.writeUInt32BE(0, location + 28);
        break;
      }
      case 'overlap': {
        changed.writeUInt32BE(changed.readUInt32BE(location + 24), location + 40);
        // No default
        break;
      }
    }
    expect(() => inspectIphoneBackupHeif(changed)).toThrow(UnsupportedIphoneBackupHeifError);
  });

  /** MIME 白名单只包含未编码 RDF/XML；任意 mime、品牌或多媒体轨道不能继承 HEIC 身份。 */
  it('rejects unknown metadata types, brands and non-HEIF inputs', () => {
    const unknown = layout({ xmp: 'metadata' });
    unknown.write('application/unknown', unknown.indexOf(Buffer.from('application/rdf+xml')), 'ascii');
    expect(() => inspectIphoneBackupHeif(unknown)).toThrow(UnsupportedIphoneBackupHeifError);
    const brand = Buffer.from(createSyntheticIphoneHeic());
    brand.write('zzzz', 8, 'ascii');
    expect(() => inspectIphoneBackupHeif(brand)).toThrow(UnsupportedIphoneBackupHeifError);
    expect(isIphoneBackupHeif(Buffer.from('not a HEIF file'))).toBe(false);
    expect(isIphoneBackupHeif(box('ftyp', Buffer.from('avif'), uint(0), Buffer.from('mif1avif')))).toBe(false);
  });
});
