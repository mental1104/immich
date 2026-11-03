import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { stat } from 'node:fs/promises';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DB } from 'src/schema/index.js';

/** 已有外部资产的乐观并发快照；只用于读取原片和条件补算，不创建或合并资产。 */
export interface IphoneBackupCandidate {
  id: string;
  originalPath: string;
  updateId: string;
}

/** 数据层只读原片并补空指纹；批次调度、重试和暂停由上层负责。 */
@Injectable()
export class IphoneBackupRepository {
  /** @param db 已有数据库连接。 @param crypto 沿用上传和客户端匹配的 SHA-1 实现。 */
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private crypto: CryptoRepository,
  ) {}

  /** @param libraryId 管理员配置的唯一目标库。 @returns 该库未删除且在线的外部资产查询。 */
  private assets(libraryId: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.libraryId', '=', libraryId)
      .where('asset.isExternal', '=', true)
      .where('asset.deletedAt', 'is', null)
      .where('asset.isOffline', '=', false)
      .where((eb) =>
        eb.exists(eb.selectFrom('library').select('id').where('id', '=', libraryId).where('deletedAt', 'is', null)),
      );
  }

  /** @param libraryId 唯一目标库。 @returns 数据库中的真实总量、已就绪量和缺失量。 */
  async counts(libraryId: string) {
    const row = await this.assets(libraryId)
      .select((eb) => [eb.fn.countAll().as('total'), eb.fn.count('contentChecksum').as('ready')])
      .executeTakeFirstOrThrow();
    const total = Number(row.total);
    const ready = Number(row.ready);
    return { total, ready, pending: total - ready };
  }

  /** @param libraryId 唯一目标库。 @param limit 本批最多处理数量。 @returns 优先图片、稳定排序的缺失指纹快照。 */
  candidates(libraryId: string, limit: number): Promise<IphoneBackupCandidate[]> {
    return this.assets(libraryId)
      .select(['id', 'originalPath', 'updateId'])
      .where('contentChecksum', 'is', null)
      .orderBy('type')
      .orderBy('id')
      .limit(limit)
      .execute();
  }

  /** @param row 资产快照。 @returns 当前原片字节数；非普通文件快速失败，不进行读取。 */
  async size(row: IphoneBackupCandidate): Promise<number> {
    const info = await stat(row.originalPath);
    if (!info.isFile()) {
      throw new Error('NOT_REGULAR_FILE');
    }
    return info.size;
  }

  /**
   * 流式读取并条件写入指纹；不修改原片，源文件或资产在处理期间改变时失败。
   * @param libraryId 唯一目标库。
   * @param row 选取时的路径和 updateId 版本快照，避免时间戳精度丢失。
   * @param expectedSize 本批读取预算中已确认的文件字节数。
   * @returns 成功补算后的字节数；已由其他任务补算或状态改变时拒绝覆盖。
   */
  async prepare(libraryId: string, row: IphoneBackupCandidate, expectedSize: number): Promise<number> {
    const before = await stat(row.originalPath);
    if (!before.isFile() || before.size !== expectedSize) {
      throw new Error('FILE_CHANGED');
    }
    const checksum = await this.crypto.hashFile(row.originalPath);
    const after = await stat(row.originalPath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      throw new Error('FILE_CHANGED');
    }
    // 读文件时不持有数据库锁；条件写入阻止扫描、删除或其他补算任务的过期结果。
    const result = await this.db
      .updateTable('asset')
      .set({ contentChecksum: checksum })
      .where('id', '=', row.id)
      .where('libraryId', '=', libraryId)
      .where('originalPath', '=', row.originalPath)
      .where('updateId', '=', row.updateId)
      .where('contentChecksum', 'is', null)
      .where('deletedAt', 'is', null)
      .where('isOffline', '=', false)
      .where((eb) =>
        eb.exists(eb.selectFrom('library').select('id').where('id', '=', libraryId).where('deletedAt', 'is', null)),
      )
      .executeTakeFirstOrThrow();
    if (result.numUpdatedRows !== 1n) {
      throw new Error('ASSET_CHANGED');
    }
    return before.size;
  }
}
