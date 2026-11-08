import {
  AfterDeleteTrigger,
  AfterUpdateTrigger,
  BeforeUpdateTrigger,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  type Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  type Timestamp,
  TriggerFunction,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AssetStatus, AssetType, AssetVisibility, ChecksumAlgorithm } from 'src/enum.js';
import { asset_checksum_algorithm_enum, asset_visibility_enum, assets_status_enum } from 'src/schema/enums.js';
import {
  fork_iphone_client_checksum,
  fork_iphone_promote_checksum,
  fork_iphone_reference_state,
} from 'src/schema/functions/fork-iphone-checksum.js';
import { asset_delete_audit, asset_face_update_asset_state } from 'src/schema/functions.js';
import { LibraryTable } from 'src/schema/tables/library.table.js';
import { StackTable } from 'src/schema/tables/stack.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import { ASSET_CHECKSUM_CONSTRAINT } from 'src/utils/database.js';

@Table('asset')
@UpdatedAtTrigger('asset_updatedAt')
@TriggerFunction({
  name: 'asset_fork_iphone_checksum_insert',
  timing: 'before',
  actions: ['insert'],
  scope: 'row',
  function: fork_iphone_client_checksum,
})
@BeforeUpdateTrigger({
  name: 'asset_fork_iphone_checksum_update',
  scope: 'row',
  function: fork_iphone_client_checksum,
  when: '(OLD."contentChecksum", OLD."clientChecksum", OLD."backupChecksum", OLD."backupSourceId", OLD."isOffline", OLD."deletedAt", OLD."ownerId", OLD."libraryId", OLD."checksum") IS DISTINCT FROM (NEW."contentChecksum", NEW."clientChecksum", NEW."backupChecksum", NEW."backupSourceId", NEW."isOffline", NEW."deletedAt", NEW."ownerId", NEW."libraryId", NEW."checksum")',
})
@AfterUpdateTrigger({
  name: 'asset_fork_iphone_reference_state',
  scope: 'row',
  function: fork_iphone_reference_state,
  when: '(OLD."contentChecksum", OLD."originalPath", OLD."isOffline", OLD."deletedAt", OLD."ownerId", OLD."libraryId") IS DISTINCT FROM (NEW."contentChecksum", NEW."originalPath", NEW."isOffline", NEW."deletedAt", NEW."ownerId", NEW."libraryId")',
})
@AfterUpdateTrigger({
  name: 'asset_fork_iphone_checksum_promote',
  scope: 'row',
  function: fork_iphone_promote_checksum,
})
@AfterDeleteTrigger({ name: 'asset_fork_iphone_checksum_delete', scope: 'row', function: fork_iphone_promote_checksum })
@AfterDeleteTrigger({
  scope: 'statement',
  function: asset_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() = 0',
})
@AfterUpdateTrigger({
  scope: 'row',
  function: asset_face_update_asset_state,
  when: '(OLD."ownerId", OLD."visibility", OLD."deletedAt") IS DISTINCT FROM (NEW."ownerId", NEW."visibility", NEW."deletedAt")',
})
// Checksums must be unique per user and library
@Index({
  name: ASSET_CHECKSUM_CONSTRAINT,
  columns: ['ownerId', 'checksum'],
  unique: true,
  where: '"libraryId" IS NULL',
})
@Index({
  columns: ['ownerId', 'libraryId', 'checksum'],
  unique: true,
  where: '"libraryId" IS NOT NULL',
})
@Index({
  name: 'asset_localDateTime_idx',
  expression: `("localDateTime" at time zone 'UTC')::date`,
})
@Index({
  name: 'asset_localDateTime_month_idx',
  expression: `date_trunc('MONTH'::text, ("localDateTime" AT TIME ZONE 'UTC'::text)) AT TIME ZONE 'UTC'::text`,
})
@Index({ columns: ['originalPath', 'libraryId'] })
@Index({
  name: 'fork_asset_content_checksum_idx',
  columns: ['ownerId', 'contentChecksum'],
  where: '"contentChecksum" IS NOT NULL',
})
@Index({
  name: 'fork_asset_client_checksum_idx',
  columns: ['ownerId', 'libraryId', 'clientChecksum'],
  unique: true,
  where: '"clientChecksum" IS NOT NULL',
})
@Index({ columns: ['id', 'stackId'] })
@Index({
  name: 'asset_originalFilename_trigram_idx',
  using: 'gin',
  expression: 'f_unaccent("originalFileName") gin_trgm_ops',
})
@Index({
  name: 'asset_id_timeline_notDeleted_idx',
  columns: ['id'],
  where: `visibility = 'timeline' AND "deletedAt" IS NULL`,
})
/** 资产持久化模型；独立保存路径身份、原始内容指纹及唯一客户端指纹，保留同内容副本的全部资产。 */
export class AssetTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @Column()
  type!: AssetType;

  @Column()
  originalPath!: string;

  @Column({ type: 'timestamp with time zone', index: true })
  fileCreatedAt!: Timestamp;

  @Column({ type: 'timestamp with time zone' })
  fileModifiedAt!: Timestamp;

  @Column({ type: 'boolean', default: false })
  isFavorite!: Generated<boolean>;

  @Column({ type: 'integer', nullable: true })
  duration!: number | null;

  @Column({ type: 'bytea', index: true })
  checksum!: Buffer; // sha1 checksum

  /** 外部文件的内容 SHA-1；路径 checksum 仍用于保留同内容不同路径的独立资产身份。 */
  @Column({ type: 'bytea', nullable: true })
  contentChecksum!: Buffer | null;

  /** 同库同内容仅一份在线资产持有客户端匹配指纹；其他副本使用原路径 checksum。 */
  @Column({ type: 'bytea', nullable: true })
  clientChecksum!: Buffer | null;

  /** 元数据等价版本的手机原始 SHA-1；contentChecksum 始终描述当前共用的实际原片。 */
  @Column({ type: 'bytea', nullable: true })
  backupChecksum!: Buffer | null;

  /** 共用原片的独立物理资产；版本记录保留自身 ID，源删除后自动离线而不伪造备份。 */
  @ForeignKeyColumn(() => AssetTable, { nullable: true, onUpdate: 'CASCADE', onDelete: 'SET NULL', index: true })
  backupSourceId!: string | null;

  /** 待清理暂存路径，同时防止扫描器把尚未清理的文件再次导入；不向客户端下发。 */
  @Column({ type: 'character varying', nullable: true })
  backupOriginalPath!: string | null;

  /** 压缩后的 JPEG 元数据恢复配方；共用编码图像即可逐字节恢复手机版本，无需第二份完整原片。 */
  @Column({ type: 'bytea', nullable: true })
  backupMetadata!: Buffer | null;

  @Column({ enum: asset_checksum_algorithm_enum })
  checksumAlgorithm!: ChecksumAlgorithm;

  @ForeignKeyColumn(() => AssetTable, { nullable: true, onUpdate: 'CASCADE', onDelete: 'SET NULL' })
  livePhotoVideoId!: string | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @CreateDateColumn({ index: true })
  createdAt!: Generated<Timestamp>;

  @Column({ index: true })
  originalFileName!: string;

  @Column({ type: 'bytea', nullable: true })
  thumbhash!: Buffer | null;

  @Column({ type: 'boolean', default: false })
  isOffline!: Generated<boolean>;

  @ForeignKeyColumn(() => LibraryTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  libraryId!: string | null;

  @Column({ type: 'boolean', default: false })
  isExternal!: Generated<boolean>;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone' })
  localDateTime!: Timestamp;

  @ForeignKeyColumn(() => StackTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  stackId!: string | null;

  @Column({ type: 'uuid', nullable: true, index: true })
  duplicateId!: string | null;

  @Column({ enum: assets_status_enum, default: AssetStatus.Active })
  status!: Generated<AssetStatus>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @Column({ enum: asset_visibility_enum, default: AssetVisibility.Timeline })
  visibility!: Generated<AssetVisibility>;

  @Column({ type: 'integer', nullable: true })
  width!: number | null;

  @Column({ type: 'integer', nullable: true })
  height!: number | null;

  @Column({ type: 'boolean', default: false })
  isEdited!: Generated<boolean>;
}
