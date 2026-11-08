import { Column, ForeignKeyColumn, Table } from '@immich/sql-tools';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/** 服务端接收上传时的逻辑版本信息；实际 EXIF 原始字节由 recovery 保存，不在此重新解释。 */
export interface IphoneBackupUploadSnapshot {
  originalFileName: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  type: AssetType;
  isFavorite: boolean;
  visibility: AssetVisibility;
  livePhotoVideoId: string | null;
  duration: number | null;
  localDateTime?: string;
}

/**
 * 服务端可信的上传来源和原始元数据恢复资料；公开 asset_metadata API 不能创建或改写这些记录。
 * 普通外部库导入没有此记录，不能因路径或创建时间相似就成为可清理的上传副本。
 */
@Table('fork_iphone_upload_origin')
export class ForkIphoneUploadOriginTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  @Column({ type: 'character varying' })
  originalPath!: string;

  /** 最初接收的完整文件 SHA-1，来源建立后不被后续 NAS 元数据改写覆盖。 */
  @Column({ type: 'bytea' })
  checksum!: Buffer;

  /** 最初上传的自恢复配方；未支持格式为空，不据此猜测原始元数据。 */
  @Column({ type: 'bytea', nullable: true })
  recovery!: Buffer | null;

  @Column({ type: 'jsonb' })
  snapshot!: IphoneBackupUploadSnapshot;

  /**
   * 已从来源恢复的逻辑资产 ID；有意不设级联置空外键。
   * 用户后来删除该版本时保留此 ID，避免后台把明确删除的版本重新创建。
   */
  @Column({ type: 'uuid', nullable: true })
  recoveredAssetId!: string | null;
}
