import { ForeignKeyColumn, PrimaryColumn, Table } from '@immich/sql-tools';
import { ForkAlbumCategoryTable } from 'src/schema/tables/fork-album-category.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** 可见分组在当前用户目录中的父归属；空分组名代表未分组，删除大组后自然回到默认。 */
@Table('fork_album_group_category')
export class ForkAlbumGroupCategoryTable {
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: false })
  userId!: string;

  @PrimaryColumn({ type: 'text' })
  groupName!: string;

  @ForeignKeyColumn(() => ForkAlbumCategoryTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: true })
  categoryId!: string;
}
