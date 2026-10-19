import { Column, PrimaryColumn, Table } from '@immich/sql-tools';

@Table('fork_geodata_name')
export class ForkGeodataNameTable {
  @PrimaryColumn({ type: 'integer' })
  geonameId!: number;

  @PrimaryColumn({ type: 'text' })
  kind!: 'country' | 'state' | 'city';

  @Column({ type: 'text' })
  scope!: 'global' | 'country' | 'state' | 'none';

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  country!: string;

  @Column({ type: 'text', nullable: true })
  state!: string | null;

  @Column({ type: 'text' })
  localizedName!: string;

  @Column({ type: 'text', array: true })
  aliases!: string[];
}
