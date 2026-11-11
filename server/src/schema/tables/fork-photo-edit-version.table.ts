import {
  Check,
  Column,
  CreateDateColumn,
  type Generated,
  Index,
  PrimaryColumn,
  Table,
  Timestamp,
} from '@immich/sql-tools';
import type { PhotoEditEditor } from 'src/dtos/photo-edit-advice.dto.js';

/** 记录一个工作台节点及其发布状态，二进制和报告由独立目录保存。 */
@Table('fork_photo_edit_version')
@Index({ columns: ['ownerId', 'assetId', 'createdAt'] })
@Check({ name: 'fork_photo_edit_version_kind_chk', expression: `kind IN ('codex', 'upload')` })
@Check({ name: 'fork_photo_edit_version_state_chk', expression: `state IN ('pending', 'ready', 'failed')` })
export class ForkPhotoEditVersionTable {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid' })
  ownerId!: string;

  /** 保留源标识，即使原片随后永久删除，工作台历史仍可识别。 */
  @Column({ type: 'uuid' })
  assetId!: string;

  @Column({ type: 'text' })
  assetName!: string;

  @Column({ type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({ type: 'text' })
  kind!: 'codex' | 'upload';

  @Column({ type: 'text', nullable: true })
  editor!: PhotoEditEditor | null;

  @Column({ type: 'text' })
  filename!: string;

  @Column({ type: 'text' })
  extension!: 'jpg' | 'png' | 'webp' | 'tiff' | 'heic';

  @Column({ type: 'text' })
  note!: string;

  @Column({ type: 'text', default: 'pending' })
  state!: Generated<'pending' | 'ready' | 'failed'>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  committedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
