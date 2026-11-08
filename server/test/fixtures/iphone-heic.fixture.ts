/**
 * 固定 32×32 单色 HEVC 的 VPS/SPS/PPS，由 ffmpeg/libx265 对合成色块编码生成。
 * 不含照片、相机资料或私人字节；真实 FFmpeg 已验证其输出为 1024 个相同 RGB 像素。
 */
const SYNTHETIC_HVCC =
  'AQFgAAAAkAAAAAAAHvAA/P34+AAADwOgAAEAGEABDAH//wFgAAADAJAAAAMAAAMAHpWYCaEAAQAoQgEBAWAAAAMAkAAAAwAAAwAeoEIIWWVmuTK8BaAgAAADACAAAAMAIaIAAQAGRAHBc9CJ';
const SYNTHETIC_FRAME = 'AAAAEigBrxOA9SSj//AJRX7F6v3U+A==';

/** @param value 无符号 32 位整数。@returns 四字节大端字段。 */
function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

/** @param value 无符号 16 位整数。@returns 两字节大端字段。 */
function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

/** @param type ISO 盒类型。@param pieces 只读载荷片段。@returns 带准确长度的完整盒。 */
function box(type: string, ...pieces: Buffer[]): Buffer {
  const payload = Buffer.concat(pieces);
  return Buffer.concat([u32(payload.length + 8), Buffer.from(type), payload]);
}

/** @param version FullBox 版本。@returns 无附加标志的四字节头。 */
function full(version = 0): Buffer {
  return Buffer.from([version, 0, 0, 0]);
}

/**
 * 创建可被真实 HEVC 解码器读取的合成 HEIC，无需测试环境安装编码器或存放二进制照片样本。
 * @param label 可选 XMP 标签；仅改变元数据项、容器长度和定位，不改变图像编码或解码配置。
 * @returns 具有单个 hvc1 项及可选 XMP 项的完整静态 HEIC。
 */
export function createSyntheticIphoneHeic(label?: string): Buffer {
  const frame = Buffer.from(SYNTHETIC_FRAME, 'base64');
  const escaped = label?.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const xmp =
    escaped === undefined
      ? undefined
      : Buffer.from(
          `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:subject><rdf:Bag><rdf:li>${escaped}</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>`,
        );
  const ftyp = box('ftyp', Buffer.from('heic'), u32(0), Buffer.from('heicmif1'));
  const hdlr = box('hdlr', full(), u32(0), Buffer.from('pict'), Buffer.alloc(12), Buffer.from('Synthetic\0'));
  const pitm = box('pitm', full(), u16(1));
  const imageInfo = box('infe', full(2), u16(1), u16(0), Buffer.from('hvc1synthetic\0'));
  const metadataInfo = xmp
    ? box('infe', full(2), u16(2), u16(0), Buffer.from('mimeXMP\0application/rdf+xml\0\0'))
    : undefined;
  const iinf = box('iinf', full(), u16(xmp ? 2 : 1), imageInfo, ...(metadataInfo ? [metadataInfo] : []));
  const iref = xmp ? box('iref', full(), box('cdsc', u16(2), u16(1), u16(1))) : undefined;
  const ipco = box(
    'ipco',
    box('hvcC', Buffer.from(SYNTHETIC_HVCC, 'base64')),
    box('ispe', full(), u32(32), u32(32)),
    box('pixi', full(), Buffer.from([3, 8, 8, 8])),
    box('colr', Buffer.from('nclx'), u16(1), u16(1), u16(1), Buffer.from([0])),
  );
  const ipma = box('ipma', full(), u32(1), u16(1), Buffer.from([4, 0x81, 0x82, 0x83, 0x04]));
  const iprp = box('iprp', ipco, ipma);

  /** @param offset 图像载荷在完整文件中的实际起点。@returns 指向内部 mdat 的明确长度 iloc。 */
  function locations(offset: number): Buffer {
    const image = Buffer.concat([u16(1), u16(0), u16(1), u32(offset), u32(frame.length)]);
    const metadata = xmp
      ? Buffer.concat([u16(2), u16(0), u16(1), u32(offset + frame.length), u32(xmp.length)])
      : undefined;
    return box('iloc', full(), Buffer.from([0x44, 0]), u16(xmp ? 2 : 1), image, ...(metadata ? [metadata] : []));
  }

  /** @param offset 完整文件中的实际载荷起点。@returns 固定长度静态 HEIF 容器，不读取外部文件。 */
  function metadata(offset: number): Buffer {
    return box('meta', full(), hdlr, pitm, locations(offset), iinf, ...(iref ? [iref] : []), iprp);
  }
  const provisional = metadata(0);
  return Buffer.concat([
    ftyp,
    metadata(ftyp.length + provisional.length + 8),
    box('mdat', frame, ...(xmp ? [xmp] : [])),
  ]);
}
