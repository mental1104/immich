import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** 后期来源标识供版本历史和评估选择操作建议使用。 */
export const photoEditEditor = z.enum(['lightroom', 'snapseed', 'photomator', 'other']);
export type PhotoEditEditor = z.infer<typeof photoEditEditor>;

/** 上传的附加资料随版本保存，文件来源由服务端读取上传字段。 */
export class PhotoEditUploadDto extends createZodDto(
  z.object({ parentId: z.uuid().optional(), editor: photoEditEditor, note: z.string().trim().max(200).optional() }),
) {}

/** 历史版本接口同时限定原片与版本身份。 */
export class PhotoEditVersionParamsDto extends createZodDto(z.object({ assetId: z.uuid(), id: z.uuid() })) {}

/** 界面只能请求预先定义的文件类型，不能提供文件路径。 */
export const photoEditFile = z.enum(['original', 'preview', 'image', 'annotation', 'report']);
export type PhotoEditFile = z.infer<typeof photoEditFile>;

/** 将文件类型与已授权的原片、版本组合为固定路由参数。 */
export class PhotoEditFileParamsDto extends createZodDto(
  z.object({ assetId: z.uuid(), id: z.uuid(), file: photoEditFile }),
) {}
