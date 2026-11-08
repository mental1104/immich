import { Column, ForeignKeyColumn, Index, Table } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * 严格图像本体指纹的可重建索引；完整文件 SHA-1 和实际文件签名限定其有效版本。
 * 此表只提供候选线索，不能单独授权共用、恢复或删除原片。
 */
@Table('fork_iphone_image_fingerprint')
@Index({ columns: ['imageFingerprint'] })
export class ForkIphoneImageFingerprintTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  /** 计算指纹时实际文件的完整内容 SHA-1。 */
  @Column({ type: 'bytea' })
  fileChecksum!: Buffer;

  /** 沿用严格 JPEG/PNG/HEIC 校验器的编码及必要显示配置指纹，不包含可编辑 EXIF。 */
  @Column({ type: 'text' })
  imageFingerprint!: string;

  /** dev、inode、size、mtimeNs、ctimeNs 的稳定读取签名。 */
  @Column({ type: 'text' })
  signature!: string;

  @Column({ type: 'text' })
  format!: 'JPEG' | 'PNG' | 'HEIC';
}
