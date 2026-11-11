import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { PhotoCopilotMessage } from 'src/dtos/photo-copilot.dto.js';
import type { DB } from 'src/schema/index.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoCopilotRepository } from 'src/repositories/photo-copilot.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** 使用真实迁移后的隔离 PostgreSQL，验证消息顺序、并发写入和级联清理。 */
describe(PhotoCopilotRepository.name, () => {
  let db: Kysely<DB>;

  /** 使用本套专属测试库。 */
  beforeAll(async () => {
    db = await getKyselyDB();
  });

  /** 关闭测试库连接。 */
  afterAll(async () => {
    await db.destroy();
  });

  /** @returns 一个合成会话、资产及两位独立用户，资产文件无需存在。 */
  async function setup() {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { user: otherUser } = await ctx.newUser();
    const { result: asset } = await ctx.newAsset({ ownerId: user.id });
    const repository = new PhotoCopilotRepository(db);
    const id = randomUUID();
    await repository.create(id, user.id, asset.id);
    return { repository, id, ownerId: user.id, otherUserId: otherUser.id, assetId: asset.id };
  }

  /** 问题先提交；同一位置只受理一次。重建仓库可按原顺序读回，并按用户及照片隔离列表和正文。 */
  it('commits each turn once and reloads ordered messages with the original scope', async () => {
    const { repository, id, ownerId, otherUserId, assetId } = await setup();
    const question: PhotoCopilotMessage = { id: randomUUID(), role: 'user', text: 'What is visible?' };
    const answer: PhotoCopilotMessage = { id: randomUUID(), role: 'assistant', text: 'A green square.' };
    expect(await repository.list(ownerId, assetId)).toEqual([]);
    const accepted = await Promise.all([repository.begin(id, 0, question), repository.begin(id, 0, question)]);
    expect(accepted.toSorted()).toEqual([false, true]);
    expect(await repository.get(id, ownerId, assetId)).toEqual({ status: 'starting', messages: [question] });
    expect(await repository.finish(id, 1, [answer], 'completed')).toBe(true);
    expect(await repository.finish(id, 1, [answer], 'completed')).toBe(false);

    const reloaded = new PhotoCopilotRepository(db);
    expect(await reloaded.get(id, ownerId, assetId)).toEqual({ status: 'completed', messages: [question, answer] });
    expect(await reloaded.list(ownerId, assetId)).toEqual([{ id, title: question.text }]);
    expect(await reloaded.get(id, otherUserId, assetId)).toBeUndefined();
    expect(await reloaded.get(id, ownerId, randomUUID())).toBeUndefined();
    expect(await reloaded.list(otherUserId, assetId)).toEqual([]);
  });

  /** 清除合成资产时同时清除它的会话和正文，避免留下悬空的私人历史。 */
  it('cascades from a permanently deleted asset to its sessions and messages', async () => {
    const { repository, id, ownerId, assetId } = await setup();
    await repository.begin(id, 0, { id: randomUUID(), role: 'user', text: 'Synthetic question' });
    await db.deleteFrom('asset').where('id', '=', assetId).execute();
    expect(await repository.get(id, ownerId, assetId)).toBeUndefined();
    expect(
      await db.selectFrom('fork_photo_copilot_message').where('sessionId', '=', id).select('id').execute(),
    ).toEqual([]);
  });
});
