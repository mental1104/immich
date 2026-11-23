import { Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { AlbumCategoryState } from 'src/dtos/album-category.dto.js';
import type { DB } from 'src/schema/index.js';

/** 只保存当前用户的大组与分组映射，不把个人目录偏好写入共享相簿或移动同步元数据。 */
@Injectable()
export class AlbumCategoryRepository {
  /** @param db 当前Immich数据库连接；写入范围仅限Fork目录表。 */
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  /** @param userId 当前用户。@returns 其大组及仍有可见相簿的分组归属。 */
  async getState(userId: string): Promise<AlbumCategoryState> {
    const [categories, groups] = await Promise.all([
      this.db
        .selectFrom('fork_album_category')
        .select(['id', 'name'])
        .where('userId', '=', userId)
        .orderBy('name')
        .execute(),
      this.db
        .selectFrom('fork_album_group_category as mapping')
        .innerJoin('fork_album_category as category', 'category.id', 'mapping.categoryId')
        .select(['mapping.groupName', 'mapping.categoryId'])
        .where('mapping.userId', '=', userId)
        .where('category.userId', '=', userId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('album')
              .innerJoin('album_user', 'album_user.albumId', 'album.id')
              .select('album.id')
              .where('album_user.userId', '=', userId)
              .where('album.deletedAt', 'is', null)
              .whereRef(sql<string>`trim(coalesce(album."customGroupName", ''))`, '=', 'mapping.groupName'),
          ),
        )
        .execute(),
    ]);
    return { categories, groups };
  }

  /** @param userId 当前用户。@param name 已校验名称。@returns 新大组；重名时为空。 */
  create(userId: string, name: string) {
    return this.db
      .insertInto('fork_album_category')
      .values({ id: randomUUID(), userId, name })
      .onConflict((oc) => oc.columns(['userId', 'name']).doNothing())
      .returning(['id', 'name'])
      .executeTakeFirst();
  }

  /** @param userId 当前用户。@param id 目标大组。@param name 新名称。@returns 更新后的自有大组；无权访问时为空。 */
  rename(userId: string, id: string, name: string) {
    return this.db
      .updateTable('fork_album_category')
      .set({ name })
      .where('id', '=', id)
      .where('userId', '=', userId)
      .returning(['id', 'name'])
      .executeTakeFirst();
  }

  /** @param userId 当前用户。@param id 自有大组ID。@returns 是否删除；关联级联移除后默认规则自动生效。 */
  async delete(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('fork_album_category')
      .where('id', '=', id)
      .where('userId', '=', userId)
      .executeTakeFirst();
    return result.numDeletedRows === 1n;
  }

  /** @param userId 当前用户。@param groupName 去除首尾空格的分组名。@param categoryId 自有大组或null。@returns 是否已设置；不可见分组或非自有大组返回false。 */
  async assign(userId: string, groupName: string, categoryId: string | null): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const visible = await transaction
        .selectFrom('album')
        .innerJoin('album_user', 'album_user.albumId', 'album.id')
        .select('album.id')
        .where('album_user.userId', '=', userId)
        .where('album.deletedAt', 'is', null)
        .where(sql<string>`trim(coalesce(album."customGroupName", ''))`, '=', groupName)
        .limit(1)
        .executeTakeFirst();
      if (!visible) return false;
      if (categoryId === null) {
        await transaction
          .deleteFrom('fork_album_group_category')
          .where('userId', '=', userId)
          .where('groupName', '=', groupName)
          .execute();
        return true;
      }
      // 与删除/改名串行检查所有权，避免写入期间把其他账号的大组作为父节点。
      const category = await transaction
        .selectFrom('fork_album_category')
        .select('id')
        .where('id', '=', categoryId)
        .where('userId', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!category) return false;
      await transaction
        .insertInto('fork_album_group_category')
        .values({ userId, groupName, categoryId })
        .onConflict((oc) => oc.columns(['userId', 'groupName']).doUpdateSet({ categoryId }))
        .execute();
      return true;
    });
  }
}
