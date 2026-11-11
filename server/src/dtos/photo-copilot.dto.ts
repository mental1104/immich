import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** 新建或恢复当前照片的会话；请求不能指定文件路径、模型或系统提示词。 */
export class PhotoCopilotOpenDto extends createZodDto(z.object({ sessionId: z.uuid().optional() })) {}

/** 用户消息最多 16000 字符；所有图片和元数据均由服务端按资产权限加载。 */
export class PhotoCopilotMessageDto extends createZodDto(
  z.object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(16_000)
      .refine((value) => !value.includes('\0'), 'Invalid text'),
  }),
) {}

/** 会话路由中的照片和会话标识，必须同时匹配当前用户。 */
export class PhotoCopilotParamsDto extends createZodDto(z.object({ assetId: z.uuid(), id: z.uuid() })) {}

/** 会话中对用户可见的一条正文，ID 由 Immich 生成。 */
export interface PhotoCopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/** 照片历史列表中的会话 ID 与首条问题预览。 */
export interface PhotoCopilotSessionSummary {
  id: string;
  title: string;
}

/** 浏览器可见的会话快照，不包含服务器路径、登录文件或模型推理内容。 */
export interface PhotoCopilotSnapshot {
  id: string;
  assetId: string;
  fileName: string;
  context: PhotoCopilotContext;
  image: 'original' | 'converted' | 'embedded-preview' | 'preview' | 'unavailable';
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'completed' | 'interrupted' | 'failed';
  busy: boolean;
  error: string | null;
  messages: PhotoCopilotMessage[];
}

/** 结构化照片上下文；只保留模型分析所需的公开资产字段，不包含原片所在目录。 */
export interface PhotoCopilotContext {
  version: 1;
  assetId: string;
  fileName: string;
  type: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  exif: {
    fileSizeInByte: number | null;
    dateTimeOriginal: string | null;
    make: string | null;
    model: string | null;
    lensModel: string | null;
    focalLength: number | null;
    fNumber: number | null;
    exposureTime: string | null;
    iso: number | null;
    latitude: number | null;
    longitude: number | null;
    description: string | null;
  };
  albums: { id: string; name: string }[];
  tags: { id: string; value: string }[];
  people: { id: string; name: string }[];
}
