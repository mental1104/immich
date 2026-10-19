import {
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

export const ForkAssetTask = {
  MetadataExtraction: 'metadata-extraction',
  ThumbnailGeneration: 'thumbnail-generation',
  FaceDetection: 'face-detection',
  VideoEncoding: 'video-encoding',
} as const;
export type ForkAssetTaskName = (typeof ForkAssetTask)[keyof typeof ForkAssetTask];
export const ForkAssetTaskState = {
  Queued: 'queued',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Skipped: 'skipped',
} as const;

@Table('fork_asset_task_status')
@Index({ columns: ['assetId'] })
@Index({ columns: ['taskName', 'status'] })
export class ForkAssetTaskStatusTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  @PrimaryColumn({ type: 'character varying' })
  taskName!: string;

  @Column({ type: 'character varying' })
  status!: string;

  @Column({ type: 'integer', default: 0 })
  attempts!: Generated<number>;

  @Column({ type: 'integer', default: 1 })
  generation!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  queuedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  startedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  completedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  failedAt!: Timestamp | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
