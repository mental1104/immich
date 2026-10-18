import { MetadataSearchDto } from 'src/dtos/search.dto.js';

/** 验证新增的可选全景条件不会改变旧请求，且不能绕过结构化字段校验。 */
describe('panorama search request validation', () => {
  /** 旧客户端省略新字段时继续使用原默认值，显式 false 也不被丢弃。 */
  it('accepts old requests and optional boolean panorama values', () => {
    expect(MetadataSearchDto.schema.parse({})).toEqual({ size: 250 });
    expect(MetadataSearchDto.schema.parse({ isPanorama: false }).isPanorama).toBe(false);
    expect(MetadataSearchDto.schema.safeParse({ isPanorama: 'true' }).success).toBe(false);
  });

  /** 平铺与结构化条件分别允许；混用时继续遵守现有互斥规则。 */
  it('supports structured panorama filters and rejects mixed request shapes', () => {
    expect(MetadataSearchDto.schema.safeParse({ filter: { isPanorama: { eq: true } } }).success).toBe(true);
    expect(MetadataSearchDto.schema.safeParse({ isPanorama: true, filter: { type: { eq: 'IMAGE' } } }).success).toBe(
      false,
    );
  });
});
