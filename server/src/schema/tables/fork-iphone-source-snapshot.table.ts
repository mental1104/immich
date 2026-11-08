import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  PrimaryColumn,
  Table,
  Timestamp,
} from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * 在移除完整上传副本前固定的物理源快照；原 NAS 文件以后重编码也不能覆盖此记录或快照。
 * 原始来源身份与完整 SHA-1 组成主键，路径、文件签名由专用快照校验器确认。
 */
@Table('fork_iphone_source_snapshot')
export class ForkIphoneSourceSnapshotTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  sourceId!: string;

  @PrimaryColumn({ type: 'bytea' })
  checksum!: Buffer;

  @Column({ type: 'character varying' })
  path!: string;

  /** 快照自身 dev、inode、size、mtimeNs、ctimeNs 的稳定读取签名。 */
  @Column({ type: 'text' })
  signature!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
