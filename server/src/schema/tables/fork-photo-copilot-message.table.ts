import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  PrimaryColumn,
  Table,
  Timestamp,
} from '@immich/sql-tools';
import type { PhotoCopilotMessage } from 'src/dtos/photo-copilot.dto.js';
import { ForkPhotoCopilotSessionTable } from 'src/schema/tables/fork-photo-copilot-session.table.js';

/** 用户和助手可见的文本，按会话内的位置排序；会话删除时级联清除。 */
@Table('fork_photo_copilot_message')
@Check({ name: 'fork_photo_copilot_message_role_chk', expression: `role IN ('user', 'assistant')` })
export class ForkPhotoCopilotMessageTable {
  @ForeignKeyColumn(() => ForkPhotoCopilotSessionTable, {
    primary: true,
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    index: false,
  })
  sessionId!: string;

  @PrimaryColumn({ type: 'integer' })
  position!: number;

  @Column({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  role!: PhotoCopilotMessage['role'];

  @Column({ type: 'text' })
  text!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
