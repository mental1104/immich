import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { ExpressionBuilder, Insertable, Kysely, Updateable } from 'kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { StackTable } from 'src/schema/tables/stack.table.js';
import { asUuid, withDefaultVisibility } from 'src/utils/database.js';

export interface StackSearch {
  ownerId: string;
  primaryAssetId?: string;
}

const withAssets = (eb: ExpressionBuilder<DB, 'stack'>, withTags = false) => {
  return jsonArrayFrom(
    eb
      .selectFrom('asset')
      .selectAll('asset')
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('asset_exif')
            .select(columns.exif)
            .whereRef('asset_exif.assetId', '=', 'asset.id')
            .as('exifInfo'),
        (join) => join.onTrue(),
      )
      .$if(withTags, (eb) =>
        eb.select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('tag')
              .select(columns.tag)
              .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
              .whereRef('tag_asset.assetId', '=', 'asset.id'),
          ).as('tags'),
        ),
      )
      .select((eb) => eb.fn.toJson('exifInfo').as('exifInfo'))
      .where('asset.deletedAt', 'is', null)
      .whereRef('asset.stackId', '=', 'stack.id')
      .$call(withDefaultVisibility)
      .orderBy('asset.fileCreatedAt', 'asc'),
  ).as('assets');
};

@Injectable()
/** 持久化现有照片堆叠，并对唯一 RAW/成片拍摄参数配对提供事务与幂等保护。 */
export class StackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * 把拍摄参数唯一匹配的 NEF/DNG 与 JPG/HEIC/HEIF 放入既有堆叠，成片为封面；不删除或移动原片。
   * @param assetId 元数据提取完成的资源 ID，允许由任一文件先触发。
   * @param ownerId 事件所属用户；查询与事务均限定此用户。
   * @returns 新建的 stackId；无唯一配对、信息不足或已有堆叠时为 undefined。
   */
  async autoStackRawPair(assetId: string, ownerId: string): Promise<string | undefined> {
    const anchor = await this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.originalFileName',
        'asset.libraryId',
        'asset.isExternal',
        'asset.visibility',
        'asset.stackId',
        'asset_exif.model',
        'asset_exif.dateTimeOriginal',
        'asset_exif.exposureTime',
        'asset_exif.fNumber',
        'asset_exif.focalLength',
        'asset_exif.iso',
      ])
      .where('asset.id', '=', assetId)
      .where('asset.ownerId', '=', ownerId)
      .where('asset.type', '=', AssetType.Image)
      .where('asset.deletedAt', 'is', null)
      .executeTakeFirst();
    if (
      !anchor ||
      anchor.stackId ||
      !anchor.dateTimeOriginal ||
      !anchor.model ||
      !anchor.exposureTime ||
      anchor.fNumber === null ||
      anchor.focalLength === null ||
      anchor.iso === null ||
      !/[.](nef|dng|jpe?g|heic|heif)$/i.test(anchor.originalFileName) ||
      (anchor.visibility !== AssetVisibility.Timeline && anchor.visibility !== AssetVisibility.Archive)
    ) {
      return;
    }

    return this.db.transaction().execute(async (tx) => {
      // 同一用户的配对串行执行，避免同时完成时重复建堆叠。
      await sql`select pg_advisory_xact_lock(hashtextextended(${`raw-pair:${ownerId}`}, 0))`.execute(tx);
      const candidates = await tx
        .selectFrom('asset')
        .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .select(['asset.id', 'asset.originalFileName', 'asset.stackId'])
        .where('asset.ownerId', '=', ownerId)
        .where('asset.libraryId', anchor.libraryId === null ? 'is' : '=', anchor.libraryId)
        .where('asset.isExternal', '=', anchor.isExternal)
        .where('asset.type', '=', AssetType.Image)
        .where('asset.visibility', '=', anchor.visibility)
        .where('asset.deletedAt', 'is', null)
        .where('asset_exif.model', '=', anchor.model)
        .where('asset_exif.dateTimeOriginal', '=', anchor.dateTimeOriginal)
        .where('asset_exif.exposureTime', '=', anchor.exposureTime)
        .where('asset_exif.fNumber', '=', anchor.fNumber)
        .where('asset_exif.focalLength', '=', anchor.focalLength)
        .where('asset_exif.iso', '=', anchor.iso)
        .where(sql<boolean>`asset."originalFileName" ~* '[.](nef|dng|jpe?g|heic|heif)$'`)
        .orderBy('asset.id')
        .forUpdate('asset')
        .execute();
      const raw = candidates.filter((asset) => /[.](nef|dng)$/i.test(asset.originalFileName));
      const rendered = candidates.filter((asset) => /[.](jpe?g|heic|heif)$/i.test(asset.originalFileName));
      // 仅在完整拍摄参数唯一匹配时配对；不猜测歧义候选，也不覆盖手工堆叠。
      if (
        candidates.length !== 2 ||
        raw.length !== 1 ||
        rendered.length !== 1 ||
        candidates.every((asset) => asset.id !== assetId) ||
        candidates.some((asset) => asset.stackId)
      ) {
        return;
      }
      const stack = await tx
        .insertInto('stack')
        .values({ ownerId, primaryAssetId: rendered[0].id })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('asset')
        .set({ stackId: stack.id, updatedAt: new Date() })
        .where('id', 'in', [rendered[0].id, raw[0].id])
        .execute();
      return stack.id;
    });
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID }] })
  search(query: StackSearch) {
    return this.db
      .selectFrom('stack')
      .selectAll('stack')
      .select(withAssets)
      .where('stack.ownerId', '=', query.ownerId)
      .$if(!!query.primaryAssetId, (eb) => eb.where('stack.primaryAssetId', '=', query.primaryAssetId!))
      .execute();
  }

  async create(entity: Omit<Insertable<StackTable>, 'primaryAssetId'>, assetIds: string[]) {
    return this.db.transaction().execute(async (tx) => {
      const stacks = await tx
        .selectFrom('stack')
        .where('stack.ownerId', '=', entity.ownerId)
        .where('stack.primaryAssetId', 'in', assetIds)
        .select('stack.id')
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('asset')
              .select('asset.id')
              .whereRef('asset.stackId', '=', 'stack.id')
              .where('asset.deletedAt', 'is', null),
          ).as('assets'),
        )
        .execute();

      const uniqueIds = new Set<string>(assetIds);

      // children
      for (const stack of stacks) {
        if (stack.assets && stack.assets.length > 0) {
          for (const asset of stack.assets) {
            uniqueIds.add(asset.id);
          }
        }
      }

      if (stacks.length > 0) {
        await tx
          .deleteFrom('stack')
          .where(
            'id',
            'in',
            stacks.map((stack) => stack.id),
          )
          .execute();
      }

      const newRecord = await tx
        .insertInto('stack')
        .values({ ...entity, primaryAssetId: assetIds[0] })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('asset')
        .set({
          stackId: newRecord.id,
          updatedAt: new Date(),
        })
        .where('id', 'in', [...uniqueIds])
        .execute();

      return tx
        .selectFrom('stack')
        .selectAll('stack')
        .select(withAssets)
        .where('id', '=', newRecord.id)
        .executeTakeFirstOrThrow();
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('stack').where('id', '=', asUuid(id)).execute();
  }

  async deleteAll(ids: string[]): Promise<void> {
    await this.db.deleteFrom('stack').where('id', 'in', ids).execute();
  }

  update(id: string, entity: Updateable<StackTable>) {
    return this.db
      .updateTable('stack')
      .set(entity)
      .where('id', '=', asUuid(id))
      .returningAll('stack')
      .returning((eb) => withAssets(eb, true))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(id: string) {
    return this.db
      .selectFrom('stack')
      .selectAll()
      .select((eb) => withAssets(eb, true))
      .where('id', '=', asUuid(id))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getForAssetRemoval(assetId: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select(['stackId as id', 'stack.primaryAssetId'])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ sourceId: DummyValue.UUID, targetId: DummyValue.UUID }] })
  merge({ sourceId, targetId }: { sourceId: string; targetId: string }) {
    return this.db.updateTable('asset').set({ stackId: targetId }).where('asset.stackId', '=', sourceId).execute();
  }
}
