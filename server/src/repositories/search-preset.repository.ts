import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { SearchPresetDto } from 'src/dtos/search-preset.dto.js';
import type { DB } from 'src/schema/index.js';

/** 只在当前用户的Fork登记表中读写，名称唯一性最终由数据库约束裁决。 */
@Injectable()
export class SearchPresetRepository {
  /** @param db 当前数据库连接，所有方法必须显式限定用户。 */
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  /** @param userId 认证账号。@returns 该账号全部登记项，不含内部用户字段。 */
  getAll(userId: string) {
    return this.db
      .selectFrom('fork_search_preset')
      .select(['id', 'name', 'conditions'])
      .where('userId', '=', userId)
      .orderBy('name')
      .execute();
  }
  /** @param userId 认证账号。@param dto 已校验名称/条件。@returns 新登记项；重名返回空。 */
  create(userId: string, dto: SearchPresetDto) {
    return this.db
      .insertInto('fork_search_preset')
      .values({ id: randomUUID(), userId, ...dto })
      .onConflict((oc) => oc.columns(['userId', 'name']).doNothing())
      .returning(['id', 'name', 'conditions'])
      .executeTakeFirst();
  }
  /** @param userId 认证账号。@param id 自有登记项ID。@param dto 新名称/条件。@returns 修改结果；无权限返回空，重名抛唯一约束错误。 */
  update(userId: string, id: string, dto: SearchPresetDto) {
    return this.db
      .updateTable('fork_search_preset')
      .set(dto)
      .where('userId', '=', userId)
      .where('id', '=', id)
      .returning(['id', 'name', 'conditions'])
      .executeTakeFirst();
  }
  /** @param userId 认证账号。@param id 自有登记项ID。@returns 是否已删除。 */
  async delete(userId: string, id: string) {
    const result = await this.db
      .deleteFrom('fork_search_preset')
      .where('userId', '=', userId)
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numDeletedRows === 1n;
  }
}
