import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** 缺少大组归属时的虚拟名称；保持旧数据无需回填。 */
export const DEFAULT_ALBUM_CATEGORY_NAME = '默认';

/** 只接受当前用户的大组名称；系统默认大组不占数据库记录。 */
export class AlbumCategoryNameDto extends createZodDto(z.object({ name: z.string().trim().min(1).max(100) })) {}

/** 按分组设置可选大组；null表示回默认，不改变相簿名称、内容或共享关系。 */
export class AlbumGroupCategoryDto extends createZodDto(
  z.object({ groupName: z.string().trim(), categoryId: z.uuid().nullable() }),
) {}

/** 当前用户自己的大组及可见分组归属；默认大组由客户端和搜索统一按缺省解释。 */
export interface AlbumCategoryState {
  categories: Array<{ id: string; name: string }>;
  groups: Array<{ groupName: string; categoryId: string }>;
}
