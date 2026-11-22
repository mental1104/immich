import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** 当前已加载时间桶的照片ID；不接受路径、用户ID或计算参数。 */
export class SceneStackQueryDto extends createZodDto(z.object({ ids: z.array(z.uuid()).max(5000) })) {}

/** 外层分组只包含当前用户可见的原生时间线单元，原生stack保持独立。 */
export interface SceneStackGroup {
  id: string;
  coverId: string;
  members: string[];
}

/** 未配置或证据失效时返回空分组，浏览器保留完整原生时间线。 */
export interface SceneStackReply {
  available: boolean;
  groups: SceneStackGroup[];
}
