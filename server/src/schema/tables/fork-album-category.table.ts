import { Column, ForeignKeyColumn, PrimaryColumn, Table, Unique } from '@immich/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/** 用户自己的可选相簿大组；默认大组是读取约定，不创建记录，也不回填旧相簿。 */
@Table('fork_album_category')
@Unique({ columns: ['userId', 'name'] })
export class ForkAlbumCategoryTable {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  userId!: string;

  @Column({ type: 'text' })
  name!: string;
}
