import { ForeignKeyColumn, Index, Table } from '@immich/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { TagTable } from 'src/schema/tables/tag.table.js';

@Index({ columns: ['albumId', 'tagId'] })
@Table('album_tag')
export class AlbumTagTable {
  @ForeignKeyColumn(() => AlbumTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: true })
  albumId!: string;

  @ForeignKeyColumn(() => TagTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: true })
  tagId!: string;
}
