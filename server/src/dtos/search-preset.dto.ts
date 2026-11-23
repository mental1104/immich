import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** 登记项只保存可还原的原子条件，不接受用户范围、分页或任意SQL/查询树。 */
export const SearchPresetConditionsSchema = z
  .strictObject({
    query: z
      .object({
        value: z.string().min(1).max(2000),
        type: z.enum(['smart', 'metadata', 'description', 'fullPath', 'ocr']),
      })
      .optional(),
    queryAssetId: z.uuid().optional(),
    personIds: z.array(z.uuid()).min(1).max(100).optional(),
    tagIds: z.array(z.uuid()).min(1).max(100).nullable().optional(),
    country: z.string().max(256).optional(),
    state: z.string().max(256).optional(),
    city: z.string().max(256).optional(),
    make: z.string().max(256).optional(),
    model: z.string().max(256).optional(),
    lensModel: z.string().max(256).optional(),
    deviceModels: z.array(z.string().min(1).max(256)).min(1).max(50).optional(),
    takenAfter: z.iso.date().optional(),
    takenBefore: z.iso.date().optional(),
    isArchive: z.literal(true).optional(),
    isFavorite: z.literal(true).optional(),
    albumStatus: z.enum(['in', 'notIn']).optional(),
    mediaType: z.enum(['image', 'video']).optional(),
    isPanorama: z.literal(true).optional(),
    mediaCategory: z
      .enum([
        'phone-video',
        'screenshot',
        'delta-screenshot',
        'steam-screenshot',
        'switch-screenshot',
        '3ds-screenshot',
      ])
      .optional(),
    resolution: z.enum(['720p', '1080p', '2k', '4k']).optional(),
    orientation: z.enum(['landscape', 'portrait']).optional(),
    rating: z.number().int().min(0).max(5).nullable().optional(),
    exifConditions: z
      .array(
        z.strictObject({
          field: z.enum(['iso', 'fNumber', 'exposureTime', 'focalLength']),
          operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
          value: z.number().finite().nonnegative(),
        }),
      )
      .min(1)
      .max(20)
      .optional(),
  })
  .refine((conditions) => Object.keys(conditions).length > 0, 'At least one search condition is required')
  .refine((conditions) => {
    // 同字段/运算符只有一个原子槽位，拒绝重复槽位，避免还原时出现同键条目。
    const ids = conditions.exifConditions?.map(({ field, operator }) => `${field}:${operator}`) ?? [];
    return new Set(ids).size === ids.length;
  }, 'Duplicate EXIF condition');

/** JSON中没有Set、DateTime或账号字段，可以跨浏览器安全还原。 */
export type SearchPresetConditions = z.infer<typeof SearchPresetConditionsSchema>;

/** 当前账号新建或修改的具名登记项；条件仅用于恢复UI，搜索时仍走原鉴权。 */
export class SearchPresetDto extends createZodDto(
  z.object({ name: z.string().trim().min(1).max(100), conditions: SearchPresetConditionsSchema }),
) {}
