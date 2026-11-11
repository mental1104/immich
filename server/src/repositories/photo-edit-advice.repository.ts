import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { ForkPhotoEditVersionTable } from 'src/schema/tables/fork-photo-edit-version.table.js';
import { AssetVisibility } from 'src/enum.js';

/** 数据库中的工作台版本；同一原片可以有多条分支。 */
export type PhotoEditVersion = Selectable<ForkPhotoEditVersionTable>;

/** 查询和更新版本目录，访问约束由调用方用登录用户及源资产共同确定。 */
@Injectable()
export class PhotoEditAdviceRepository {
  /** @param db Immich 使用的 PostgreSQL 连接。 */
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** @param ownerId 登录用户。@returns 有记录的待修照片及最后操作时间，最近优先。 */
  projects(ownerId: string) {
    return this.db
      .selectFrom('fork_photo_edit_version as version')
      .innerJoin('asset as source', 'source.id', 'version.assetId')
      .select([
        'version.assetId',
        'source.originalFileName as assetName',
        (eb) => eb.fn.max('version.createdAt').as('updatedAt'),
      ])
      .where('version.ownerId', '=', ownerId)
      .where('source.ownerId', '=', ownerId)
      .where('source.deletedAt', 'is', null)
      .where('source.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .groupBy(['version.assetId', 'source.originalFileName'])
      .orderBy('updatedAt', 'desc')
      .execute();
  }

  /** @param ownerId 登录用户。@param assetId 待修原片。@returns 该照片完整历史，按上传顺序。 */
  list(ownerId: string, assetId: string) {
    return this.db
      .selectFrom('fork_photo_edit_version')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('assetId', '=', assetId)
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
  }

  /** @param ownerId 登录用户。@param assetId 待修原片。@param id 版本。@returns 匹配行或 undefined。 */
  get(ownerId: string, assetId: string, id: string) {
    return this.db
      .selectFrom('fork_photo_edit_version')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .where('assetId', '=', assetId)
      .executeTakeFirst();
  }

  /** @param version 服务端生成的元数据。@returns 已写入的版本。 */
  create(version: Insertable<ForkPhotoEditVersionTable>) {
    return this.db.insertInto('fork_photo_edit_version').values(version).returningAll().executeTakeFirstOrThrow();
  }

  /** @param id 已授权的版本 ID。@param change 报告状态或提交时间。@returns 更新后的行。 */
  update(id: string, change: Pick<Updateable<ForkPhotoEditVersionTable>, 'state' | 'committedAt'>) {
    return this.db
      .updateTable('fork_photo_edit_version')
      .set(change)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
