import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Index,
  PrimaryColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** 需要跨进程保留的状态；starting 表示已保存问题但尚未提交本轮结果。 */
export type PhotoCopilotStoredStatus = 'idle' | 'starting' | 'completed' | 'interrupted' | 'failed';

/** 每个会话绑定一个用户和一张照片，记录消息数及最近一轮的保存状态。 */
@Table('fork_photo_copilot_session')
@Index({ columns: ['ownerId', 'assetId', 'updatedAt'] })
@Check({
  name: 'fork_photo_copilot_session_status_chk',
  expression: `status IN ('idle', 'starting', 'completed', 'interrupted', 'failed')`,
})
export class ForkPhotoCopilotSessionTable {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: true })
  assetId!: string;

  @Column({ type: 'text', default: 'idle' })
  status!: Generated<PhotoCopilotStoredStatus>;

  /** 已提交的消息数，也是下一条消息的位置，用于防止旧进程覆盖新一轮。 */
  @Column({ type: 'integer', default: 0 })
  messageCount!: Generated<number>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
