import { Injectable } from '@nestjs/common';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { Kysely } from 'kysely';
import type { PhotoCopilotMessage, PhotoCopilotSessionSummary } from 'src/dtos/photo-copilot.dto.js';
import type { DB } from 'src/schema/index.js';
import type { PhotoCopilotStoredStatus } from 'src/schema/tables/fork-photo-copilot-session.table.js';

/** 保存 Photo Copilot 可见文本及会话状态，调用方负责验证当前照片权限。 */
@Injectable()
export class PhotoCopilotRepository {
  /** @param db Immich 的 PostgreSQL 连接。 */
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** @param id 服务端生成的会话 UUID。@param ownerId 登录用户。@param assetId 照片。写入空会话。 */
  async create(id: string, ownerId: string, assetId: string): Promise<void> {
    await this.db.insertInto('fork_photo_copilot_session').values({ id, ownerId, assetId }).execute();
  }

  /** @param id 会话。@param ownerId 登录用户。@param assetId 照片。@returns 匹配的会话及有序正文，缺失时为 undefined。 */
  get(id: string, ownerId: string, assetId: string) {
    return this.db
      .selectFrom('fork_photo_copilot_session as session')
      .select('session.status')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('fork_photo_copilot_message')
            .select(['id', 'role', 'text'])
            .whereRef('sessionId', '=', 'session.id')
            .orderBy('position'),
        ).as('messages'),
      )
      .where('session.id', '=', id)
      .where('session.ownerId', '=', ownerId)
      .where('session.assetId', '=', assetId)
      .executeTakeFirst();
  }

  /** @param ownerId 登录用户。@param assetId 照片。@returns 最近活跃的有消息会话，只返回首句预览。 */
  list(ownerId: string, assetId: string): Promise<PhotoCopilotSessionSummary[]> {
    return this.db
      .selectFrom('fork_photo_copilot_session as session')
      .innerJoin('fork_photo_copilot_message as message', (join) =>
        join.onRef('message.sessionId', '=', 'session.id').on('message.position', '=', 0),
      )
      .select('session.id')
      .select((eb) => eb.fn<string>('left', ['message.text', eb.val(100)]).as('title'))
      .where('session.ownerId', '=', ownerId)
      .where('session.assetId', '=', assetId)
      .orderBy('session.updatedAt', 'desc')
      .orderBy('session.id', 'desc')
      .execute();
  }

  /**
   * 在调用 Codex 前原子追加问题并标记本轮已启动。
   * @param id 会话。@param position 当前消息数。@param message 本轮用户消息。
   * @returns 写入是否成功；位置冲突时不写入，调用方应重新打开会话。
   */
  begin(id: string, position: number, message: PhotoCopilotMessage): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      // 条件 UPDATE 串行化同一会话的写入，并在拿到行锁后重新验证位置。
      const row = await tx
        .updateTable('fork_photo_copilot_session')
        .set({ status: 'starting', messageCount: position + 1, updatedAt: new Date() })
        .where('id', '=', id)
        .where('messageCount', '=', position)
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;
      await tx
        .insertInto('fork_photo_copilot_message')
        .values({ ...message, sessionId: id, position })
        .execute();
      return true;
    });
  }

  /**
   * 原子提交一轮已显示的助手正文及终态，避免回放看到半次提交。
   * @param id 会话。@param position 本轮用户消息之后的位置。@param messages 助手文本，可为空。
   * @param status 终态。@returns 写入是否成功；旧位置或重复终态不会覆盖已保存的数据。
   */
  finish(
    id: string,
    position: number,
    messages: PhotoCopilotMessage[],
    status: Exclude<PhotoCopilotStoredStatus, 'idle' | 'starting'>,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable('fork_photo_copilot_session')
        .set({ status, messageCount: position + messages.length, updatedAt: new Date() })
        .where('id', '=', id)
        .where('messageCount', '=', position)
        .where('status', '=', 'starting')
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;
      if (messages.length > 0) {
        await tx
          .insertInto('fork_photo_copilot_message')
          .values(messages.map((message, index) => ({ ...message, sessionId: id, position: position + index })))
          .execute();
      }
      return true;
    });
  }
}
