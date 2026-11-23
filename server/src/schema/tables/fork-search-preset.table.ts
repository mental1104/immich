import { Column, ForeignKeyColumn, PrimaryColumn, Table, Unique } from '@immich/sql-tools';
import type { SearchPresetConditions } from 'src/dtos/search-preset.dto.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** 用户登记的搜索条件组合；内置登记项留在Web定义中，不回填用户或官方手机同步表。 */
@Table('fork_search_preset')
@Unique({ columns: ['userId', 'name'] })
export class ForkSearchPresetTable {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  userId!: string;
  @Column({ type: 'text' })
  name!: string;
  @Column({ type: 'jsonb' })
  conditions!: SearchPresetConditions;
}
