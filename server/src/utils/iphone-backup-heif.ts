import { createHash } from 'node:crypto';

/** 只接收可完整保存与恢复的有界静态 HEIC，不读取轨道、外部数据或未知编码结构。 */
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'miaf',
  'MiHE',
  // MP4RA 注册的 MIAF 渐进解码/渲染品牌；仍校验完整 ftyp、图像图及所有解码属性。
  // https://mp4ra.org/registered-types/brands
  'MiPr',
  'MiHB',
  'MiHA',
  'tmap',
]);
const IMAGE_TYPES = new Set(['hvc1', 'grid', 'iden', 'iovl', 'tmap']);
const REFERENCES = new Set(['dimg', 'thmb', 'auxl', 'prem', 'cdsc']);
const PROPERTIES = new Set([
  'hvcC',
  'ispe',
  'pixi',
  'colr',
  'irot',
  'imir',
  'auxC',
  'clap',
  'pasp',
  'rloc',
  'lsel',
  'mdcv',
  'clli',
]);

/** 未覆盖结构采用完整文件备份，不把未知 HEIF 语义当成可忽略元数据。 */
export class UnsupportedIphoneBackupHeifError extends Error {
  /** 固定 ASCII 错误供调用者选择保留完整文件，不与 I/O 错误混为一类。 */
  constructor() {
    super('Unsupported backup HEIF structure');
    this.name = 'UnsupportedIphoneBackupHeifError';
  }
}

/** 文件中的有界盒；data 跳过普通或扩展长度头，不跳过 FullBox 字段。 */
interface Box {
  type: string;
  start: number;
  data: number;
  end: number;
}
/** 一个条目的实际载荷范围；index 是该条目内的逻辑范围顺序。 */
interface Extent {
  start: number;
  end: number;
  index: number;
  container: number;
}
/** 固定 ID、原始定义及经过验证的内部位置，不以名字猜测条目角色。 */
interface Item {
  id: number;
  type: string;
  metadata: boolean;
  info: Buffer;
  extents: Extent[];
}
/** 返回顺序片段覆盖完整文件，只有已证明的图像载荷可从另一个来源复用。 */
export interface IphoneBackupHeifInspection {
  pieces: { bytes: Buffer; metadata: boolean }[];
  fingerprint: string;
}

/** @param condition 必须成立的格式或边界约束。@returns 失败时抛出可辨识的保守降级错误。 */
function ensure(condition: unknown): asserts condition {
  if (!condition) throw new UnsupportedIphoneBackupHeifError();
}

/** @param bytes 原始结构或载荷字节。@returns 固定长度结构证据，不替代最后的完整文件 SHA-1 验证。 */
function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 有界读取器，所有整数运算均拒绝超出 JavaScript 安全整数范围的地址。 */
class Reader {
  /** @param bytes 整个只读文件。@param pos 当前结构起点。@param end 当前结构的排他上界。 */
  constructor(
    readonly bytes: Buffer,
    public pos: number,
    readonly end: number,
  ) {
    ensure(pos >= 0 && end >= pos && end <= bytes.length);
  }

  /** @param width 编码字节数 0..8。@returns 非负安全整数并推进游标。 */
  uint(width: number): number {
    ensure(Number.isSafeInteger(width) && width >= 0 && width <= 8 && this.pos + width <= this.end);
    let value = 0n;
    for (let index = 0; index < width; index++) value = (value << 8n) | BigInt(this.bytes[this.pos++]);
    ensure(value <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(value);
  }

  /** @param width 原样字节数。@returns 有界片段并推进游标，不修改原文件。 */
  take(width: number): Buffer {
    ensure(width >= 0 && this.pos + width <= this.end);
    const value = this.bytes.subarray(this.pos, this.pos + width);
    this.pos += width;
    return value;
  }

  /** @returns 有明确 NUL 终止符的条目字符串；其余原始字节仍保留为结构证据。 */
  text(): string {
    const end = this.bytes.indexOf(0, this.pos);
    ensure(end >= this.pos && end < this.end);
    const value = this.bytes.toString('utf8', this.pos, end);
    this.pos = end + 1;
    return value;
  }

  /** @returns 只有结构被完整消费才成功，未知尾部不能自动丢弃。 */
  finish(): void {
    ensure(this.pos === this.end);
  }
}

/** 严格静态 HEIC 子集解析器；所有未知盒、未知属性和重叠位置均退回完整备份。 */
class HeifParser {
  private entries = 0;
  private extentCount = 0;
  private nalUnits = 0;
  private referencedEntities = 0;

  /** @param bytes 最大 64 MiB 的完整 HEIF 文件；返回片段只引用它，不改变它。 */
  constructor(private readonly bytes: Buffer) {
    ensure(bytes.length <= MAX_BYTES);
  }

  /** @param start 子盒区域起点。@param end 排他上界。@returns 完整且不交叠的直接子盒，数量全文件有界。 */
  private boxes(start: number, end: number): Box[] {
    const output: Box[] = [];
    const reader = new Reader(this.bytes, start, end);
    while (reader.pos < end) {
      ensure(++this.entries <= MAX_ENTRIES * 4 && reader.pos + 8 <= end);
      const position = reader.pos;
      const short = reader.uint(4);
      const type = reader.take(4).toString('ascii');
      ensure(/^[\u{20}-\u{7E}]{4}$/u.test(type));
      const size = short === 1 ? reader.uint(8) : short === 0 ? end - position : short;
      ensure(size >= reader.pos - position && position + size <= end);
      if (short === 0) ensure(type === 'mdat');
      output.push({ type, start: position, data: reader.pos, end: position + size });
      reader.pos = position + size;
    }
    reader.finish();
    return output;
  }

  /** @param box 当前 FullBox。@param versions 明确支持的版本。@param flags 明确支持的标志位组合。@returns 头后游标及版本。 */
  private full(box: Box, versions: readonly number[] = [0], flags: readonly number[] = [0]) {
    const reader = new Reader(this.bytes, box.data, box.end);
    const version = reader.uint(1),
      flag = reader.uint(3);
    ensure(versions.includes(version) && flags.includes(flag));
    return { reader, version, flags: flag };
  }

  /** @param boxes 同层子盒。@param type 必须唯一的盒类型。@returns 该盒，否则拒绝不完整或重复定义。 */
  private single(boxes: Box[], type: string): Box {
    const found = boxes.filter((box) => box.type === type);
    ensure(found.length === 1);
    return found[0];
  }

  /** @param box 已解析盒。@returns 包含类型及编码长度的完整原始结构证据。 */
  private raw(box: Box): string {
    return hash(this.bytes.subarray(box.start, box.end));
  }

  /** @param box 具有受支持品牌的 ftyp。@returns 验证通过；品牌与版本原样参与结构摘要。 */
  private ftyp(box: Box): void {
    const reader = new Reader(this.bytes, box.data, box.end);
    ensure(box.end - box.data >= 8 && (box.end - box.data) % 4 === 0);
    ensure(BRANDS.has(reader.take(4).toString('ascii')));
    reader.uint(4);
    while (reader.pos < reader.end) ensure(BRANDS.has(reader.take(4).toString('ascii')));
  }

  /** @param box 静态图片处理器。@returns 仅 pict、无其他处理器或扩展标志才成功。 */
  private handler(box: Box): void {
    const { reader } = this.full(box);
    ensure(reader.uint(4) === 0 && reader.take(4).toString('ascii') === 'pict');
    ensure(reader.take(12).every((value) => value === 0));
    if (!(reader.pos < reader.end)) {
      return;
    }

    reader.text();
    reader.finish();
  }

  /** @param box 仅含本文件 self-contained URL 的数据引用结构。@returns 外部引用即使未被使用也拒绝。 */
  private dataInformation(box: Box): void {
    const dref = this.single(this.boxes(box.data, box.end), 'dref');
    ensure(dref.start === box.data && dref.end === box.end);
    const { reader } = this.full(dref);
    ensure(reader.uint(4) === 1);
    const url = this.single(this.boxes(reader.pos, reader.end), 'url ');
    ensure(url.start === reader.pos && url.end === reader.end);
    this.full(url, [0], [1]).reader.finish();
  }

  /** @param box 条目信息表。@returns 显式标记 Exif 与未编码 XMP，其余仅接受已知 HEVC/派生图像类型。 */
  private items(box: Box): Map<number, Item> {
    const { reader, version } = this.full(box, [0, 1]);
    const count = reader.uint(version === 0 ? 2 : 4);
    ensure(count > 0 && count <= MAX_ENTRIES);
    const items = new Map<number, Item>();
    for (const entry of this.boxes(reader.pos, reader.end)) {
      ensure(entry.type === 'infe');
      const info = this.full(entry, [2, 3], [0, 1]);
      const id = info.reader.uint(info.version === 2 ? 2 : 4);
      ensure(id > 0 && !items.has(id) && info.reader.uint(2) === 0);
      const type = info.reader.take(4).toString('ascii');
      info.reader.text();
      let metadata = type === 'Exif';
      if (type === 'mime') {
        metadata = info.reader.text() === 'application/rdf+xml';
        ensure(metadata);
        if (info.reader.pos < info.reader.end) ensure(info.reader.text() === '');
      } else ensure(metadata || IMAGE_TYPES.has(type));
      info.reader.finish();
      items.set(id, { id, type, metadata, info: this.bytes.subarray(entry.start, entry.end), extents: [] });
    }
    ensure(items.size === count && items.values().some((item) => item.type === 'hvc1'));
    return items;
  }

  /** @param box 内部地址表。@param items 已声明条目。@param media 顶层 mdat。@param idat 可选内部 idat。@returns 所有条目的安全范围，拒绝构造方式 2 和外部引用。 */
  private locations(box: Box, items: Map<number, Item>, media: Box[], idat?: Box): void {
    const { reader, version } = this.full(box, [0, 1, 2]);
    const widths = reader.uint(2);
    const offsetWidth = widths >> 12,
      lengthWidth = (widths >> 8) & 15,
      baseWidth = (widths >> 4) & 15;
    const indexWidth = version > 0 ? widths & 15 : 0;
    ensure([offsetWidth, lengthWidth, baseWidth, indexWidth].every((width) => width <= 8));
    ensure(version > 0 || (widths & 15) === 0);
    const count = reader.uint(version < 2 ? 2 : 4);
    ensure(count === items.size);
    const located = new Set<number>();
    for (let index = 0; index < count; index++) {
      const id = reader.uint(version < 2 ? 2 : 4),
        item = items.get(id);
      const method = version > 0 ? reader.uint(2) : 0;
      ensure(item && !located.has(id) && method <= 1 && reader.uint(2) === 0);
      located.add(id);
      const base = reader.uint(baseWidth),
        extents = reader.uint(2);
      ensure(extents > 0 && extents <= MAX_ENTRIES && (method !== 1 || idat));
      for (let extent = 0; extent < extents; extent++) {
        ensure(++this.extentCount <= MAX_ENTRIES * 2);
        if (version > 0) ensure(reader.uint(indexWidth) === 0);
        const offset = reader.uint(offsetWidth),
          length = reader.uint(lengthWidth);
        const start = base + offset + (method === 1 ? idat!.data : 0),
          end = start + length;
        ensure(length > 0 && Number.isSafeInteger(start) && Number.isSafeInteger(end));
        const container = method === 1 ? idat : media.find((part) => start >= part.data && end <= part.end);
        ensure(container && start >= container.data && end <= container.end);
        item.extents.push({ start, end, index: extent, container: container.start });
      }
    }
    reader.finish();
  }

  /** @param box 已知解码属性。@returns 验证基础边界与版本，完整属性原始字节仍参与不变量。 */
  private property(box: Box): void {
    ensure(PROPERTIES.has(box.type));
    const reader = new Reader(this.bytes, box.data, box.end);
    switch (box.type) {
      case 'hvcC': {
        ensure(reader.take(1)[0] === 1);
        reader.take(21);
        const arrays = reader.uint(1);
        for (let array = 0; array < arrays; array++) {
          reader.uint(1);
          const count = reader.uint(2);
          ensure(count <= MAX_ENTRIES);
          for (let index = 0; index < count; index++) {
            ensure(++this.nalUnits <= MAX_ENTRIES * 2);
            const length = reader.uint(2);
            ensure(length > 0);
            reader.take(length);
          }
        }
        reader.finish();
        break;
      }
      case 'ispe': {
        const { reader } = this.full(box);
        ensure(reader.uint(4) > 0 && reader.uint(4) > 0);
        reader.finish();
        break;
      }
      case 'pixi': {
        const { reader } = this.full(box);
        const count = reader.uint(1);
        ensure(count > 0 && count <= 16);
        ensure(reader.take(count).every((bits) => bits > 0));
        reader.finish();
        break;
      }
      case 'irot': {
        ensure(reader.uint(1) <= 3);
        reader.finish();
        break;
      }
      case 'imir': {
        ensure(reader.uint(1) <= 1);
        reader.finish();
        break;
      }
      case 'auxC': {
        const { reader } = this.full(box);
        ensure(reader.text().length > 0);
        break;
      }
      case 'colr': {
        const type = reader.take(4).toString('ascii');
        ensure(['nclx', 'rICC', 'prof'].includes(type));
        if (type === 'nclx') {
          reader.take(6);
          ensure((reader.uint(1) & 127) === 0);
          reader.finish();
        } else ensure(reader.end - reader.pos >= 128);
        break;
      }
      case 'clap': {
        ensure(reader.end - reader.pos === 32);
        break;
      }
      case 'pasp': {
        ensure(reader.uint(4) > 0 && reader.uint(4) > 0);
        reader.finish();
        break;
      }
      case 'rloc': {
        const { reader } = this.full(box);
        reader.take(8);
        reader.finish();
        break;
      }
      case 'lsel': {
        reader.take(2);
        reader.finish();
        break;
      }
      case 'mdcv': {
        reader.take(24);
        reader.finish();
        break;
      }
      case 'clli': {
        reader.take(4);
        reader.finish();
        break;
      }
    }
  }

  /** @param box 属性容器。@param items 声明条目。@returns 完整校验 ipco/ipma；任何未知属性、地址或关联均拒绝。 */
  private properties(box: Box, items: Map<number, Item>): void {
    const children = this.boxes(box.data, box.end);
    ensure(children.every((child) => ['ipco', 'ipma'].includes(child.type)));
    const ipco = this.single(children, 'ipco');
    const properties = this.boxes(ipco.data, ipco.end);
    ensure(properties.length > 0 && properties.length <= MAX_ENTRIES);
    for (const property of properties) this.property(property);
    const associated = new Set<number>();
    for (const ipma of children) {
      if (ipma.type !== 'ipma') continue;
      const { reader, version, flags } = this.full(ipma, [0, 1], [0, 1]);
      const count = reader.uint(4);
      ensure(count <= items.size);
      for (let index = 0; index < count; index++) {
        const id = reader.uint(version === 0 ? 2 : 4),
          item = items.get(id);
        ensure(item && !associated.has(id));
        associated.add(id);
        const associations = reader.uint(1),
          indexes = new Set<number>();
        let configs = 0;
        for (let association = 0; association < associations; association++) {
          const value = reader.uint(flags & 1 ? 2 : 1),
            mask = flags & 1 ? 0x7f_ff : 0x7f;
          const property = value & mask;
          ensure(property <= properties.length && !indexes.has(property));
          indexes.add(property);
          if (property === 0) {
            ensure(value === 0);
            continue;
          }
          if (properties[property - 1].type === 'hvcC') configs++;
        }
        if (item.type === 'hvc1') ensure(configs === 1);
      }
      reader.finish();
    }
    ensure(
      items
        .values()
        .filter((item) => item.type === 'hvc1')
        .every((item) => associated.has(item.id)),
    );
  }

  /** @param box 可选引用表。@param items 声明条目。@returns 仅排除 Exif/XMP 到图像的 cdsc，其他关系原样进入结构摘要。 */
  private references(box: Box | undefined, items: Map<number, Item>): string[] {
    if (!box) return [];
    const { reader, version } = this.full(box, [0, 1]);
    const references: string[] = [];
    for (const entry of this.boxes(reader.pos, reader.end)) {
      ensure(REFERENCES.has(entry.type));
      const cursor = new Reader(this.bytes, entry.data, entry.end);
      const from = items.get(cursor.uint(version === 0 ? 2 : 4)),
        count = cursor.uint(2);
      ensure(from && count > 0 && count <= MAX_ENTRIES);
      const to: Item[] = [];
      for (let index = 0; index < count; index++) {
        ensure(++this.referencedEntities <= MAX_ENTRIES * 8);
        const item = items.get(cursor.uint(version === 0 ? 2 : 4));
        ensure(item);
        to.push(item);
      }
      cursor.finish();
      if (from.metadata) {
        ensure(entry.type === 'cdsc' && to.every((item) => !item.metadata));
        continue;
      }
      ensure(to.every((item) => !item.metadata));
      references.push(`${version}:${this.raw(entry)}`);
    }
    return references;
  }

  /** @param box 图片分组表。@param items 声明条目。@returns 仅支持已知 altr 替代组，原始盒完整参与摘要。 */
  private groups(box: Box, items: Map<number, Item>): void {
    const ids = new Set<number>();
    for (const group of this.boxes(box.data, box.end)) {
      ensure(group.type === 'altr');
      const { reader } = this.full(group);
      const id = reader.uint(4),
        count = reader.uint(4);
      ensure(!ids.has(id) && count > 0 && count <= items.size);
      ids.add(id);
      const entities = new Set<number>();
      for (let index = 0; index < count; index++) {
        ensure(++this.referencedEntities <= MAX_ENTRIES * 8);
        const item = items.get(reader.uint(4));
        ensure(item && !item.metadata && !entities.has(item.id));
        entities.add(item.id);
      }
      reader.finish();
    }
  }

  /** @returns 覆盖全部字节的物理顺序片段，以及不包含可变元数据地址表的严格解码不变量。 */
  inspect(): IphoneBackupHeifInspection {
    ensure(isIphoneBackupHeif(this.bytes));
    const top = this.boxes(0, this.bytes.length);
    ensure(top.every((box) => ['ftyp', 'meta', 'mdat', 'free', 'skip'].includes(box.type)));
    const ftyp = this.single(top, 'ftyp');
    ensure(ftyp.start === 0);
    this.ftyp(ftyp);
    const meta = this.single(top, 'meta'),
      header = this.full(meta);
    const children = this.boxes(header.reader.pos, header.reader.end);
    ensure(
      children.every((box) =>
        ['hdlr', 'dinf', 'pitm', 'iinf', 'iloc', 'iref', 'iprp', 'idat', 'grpl', 'free', 'skip'].includes(box.type),
      ),
    );
    for (const type of ['dinf', 'iref', 'idat', 'grpl'])
      ensure(children.filter((box) => box.type === type).length <= 1);
    this.handler(this.single(children, 'hdlr'));
    const items = this.items(this.single(children, 'iinf'));
    const pitm = this.full(this.single(children, 'pitm'), [0, 1]);
    const primary = items.get(pitm.reader.uint(pitm.version === 0 ? 2 : 4));
    ensure(primary && !primary.metadata);
    pitm.reader.finish();
    const dinf = children.find((box) => box.type === 'dinf');
    if (dinf) this.dataInformation(dinf);
    const grpl = children.find((box) => box.type === 'grpl');
    if (grpl) this.groups(grpl, items);
    this.properties(this.single(children, 'iprp'), items);
    const references = this.references(
      children.find((box) => box.type === 'iref'),
      items,
    );
    const media = top.filter((box) => box.type === 'mdat'),
      idat = children.find((box) => box.type === 'idat');
    this.locations(this.single(children, 'iloc'), items, media, idat);
    const ranges = items
      .values()
      .flatMap((item) => item.extents.map((extent) => ({ ...extent, item })))
      .toArray();
    ranges.sort((a, b) => a.start - b.start);
    const gaps: string[] = [];
    for (const container of [...media, ...(idat ? [idat] : [])]) {
      let cursor = container.data;
      for (const range of ranges) {
        if (range.container !== container.start) continue;
        ensure(range.start >= cursor);
        if (range.start > cursor) gaps.push(hash(this.bytes.subarray(cursor, range.start)));
        cursor = range.end;
      }
      if (cursor < container.end) gaps.push(hash(this.bytes.subarray(cursor, container.end)));
    }
    const core = ranges.filter((range) => !range.item.metadata);
    ensure(core.length > 0);
    const pieces: IphoneBackupHeifInspection['pieces'] = [];
    let cursor = 0;
    for (const range of core) {
      if (range.start > cursor) pieces.push({ bytes: this.bytes.subarray(cursor, range.start), metadata: true });
      pieces.push({ bytes: this.bytes.subarray(range.start, range.end), metadata: false });
      cursor = range.end;
    }
    if (cursor < this.bytes.length) pieces.push({ bytes: this.bytes.subarray(cursor), metadata: true });
    const descriptor = {
      top: top.filter((box) => !['meta', 'mdat'].includes(box.type)).map((box) => this.raw(box)),
      boxes: children.filter((box) => !['iinf', 'iloc', 'iref', 'idat'].includes(box.type)).map((box) => this.raw(box)),
      items: items
        .values()
        .filter((item) => !item.metadata)
        .toArray()
        .sort((a, b) => a.id - b.id)
        .map((item) => ({
          id: item.id,
          type: item.type,
          definition: hash(item.info),
          lengths: item.extents.map((extent) => extent.end - extent.start),
        })),
      physical: core.map((range) => ({
        id: range.item.id,
        index: range.index,
        length: range.end - range.start,
        bytes: hash(this.bytes.subarray(range.start, range.end)),
      })),
      references,
      gaps,
    };
    return { pieces, fingerprint: hash(JSON.stringify(descriptor)) };
  }
}

/** @param bytes 完整文件或至少包含完整 ftyp 的文件头。@returns 是否声明 HEIF/HEVC 品牌；识别不代表结构已获支持。 */
export function isIphoneBackupHeif(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false;
  const short = bytes.readUInt32BE(0),
    data = short === 1 ? 16 : 8;
  if (bytes.length < data + 8) return false;
  const size = short === 1 ? bytes.readBigUInt64BE(8) : BigInt(short);
  if (
    size < BigInt(data + 8) ||
    size > BigInt(bytes.length) ||
    size > BigInt(data + 8 + 64 * 4) ||
    (Number(size) - data) % 4 !== 0
  )
    return false;
  const brands = [bytes.toString('ascii', data, data + 4)];
  for (let position = data + 8; position < Number(size); position += 4)
    brands.push(bytes.toString('ascii', position, position + 4));
  return brands.every((brand) => !['avif', 'avis'].includes(brand)) && brands.some((brand) => BRANDS.has(brand));
}

/**
 * 只忽略已定位 Exif/XMP 的载荷及可变容器地址；所有图像、网格、辅助图和解码属性均严格保留。
 * @param bytes 最大 64 MiB 的完整只读 HEIF 文件。
 * @returns 完整物理分段及严格结构摘要；不支持、损坏、外部引用或重叠均抛出专用错误。
 */
export function inspectIphoneBackupHeif(bytes: Buffer): IphoneBackupHeifInspection {
  return new HeifParser(bytes).inspect();
}
