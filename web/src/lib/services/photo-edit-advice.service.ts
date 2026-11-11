import { getBaseUrl } from '@immich/sdk';

/** 手工后期软件，其他软件也可上传完整版本。 */
export type PhotoEditEditor = 'lightroom' | 'snapseed' | 'photomator' | 'other';

/** 后期历史图中的节点，已提交的版本 ID 同时是原生资产 ID。 */
export interface PhotoEditVersion {
  id: string;
  parentId: string | null;
  kind: 'codex' | 'upload';
  editor: PhotoEditEditor | null;
  filename: string;
  note: string;
  state: 'pending' | 'ready' | 'failed';
  analyzing: boolean;
  createdAt: string;
  committedAt: string | null;
}

/** 工作台首页项目索引，以及该用户可使用的生成能力。 */
export interface PhotoEditOverview {
  enabled: boolean;
  analysisEnabled: boolean;
  projects: { assetId: string; assetName: string; updatedAt: string }[];
}

/** 已打开的原片和它的所有版本。 */
export interface PhotoEditProject {
  assetId: string;
  assetName: string;
  versions: PhotoEditVersion[];
}

/** 软件中可执行的一步及观察目标。 */
export interface PhotoEditStep {
  tool: string;
  change: string;
  check: string;
}

/** 实际模型输入的像素统计，单位为百分比。 */
export interface PhotoEditHistogram {
  darkPercent: number;
  middlePercent: number;
  brightPercent: number;
  blackClippedPercent: number;
  whiteClippedPercent: number;
}

/** 生成报告与手工上传评估共用历史页，正文按来源判别。 */
export type PhotoEditReport = { source: string; original: PhotoEditHistogram } & (
  | {
      kind: 'codex';
      plan: {
        verdict: string;
        score: number;
        diagnosis: string;
        style: string;
        mask: string;
        curve: string;
        recoverable: string;
        limits: string;
        lightroom: PhotoEditStep[];
        snapseed: PhotoEditStep[];
        photomator: PhotoEditStep[];
      };
    }
  | {
      kind: 'upload';
      edited: PhotoEditHistogram;
      parent: PhotoEditHistogram | null;
      review: { verdict: string; improvements: string[]; regressions: string[]; nextStep: string };
    }
);

/** @param assetId 关联照片，可省略以请求工作台索引。@returns 同源 Fork API 地址。 */
export function photoEditUrl(assetId?: string): string {
  return `${getBaseUrl()}/fork/photo-edit-advice${assetId ? '/assets/' + encodeURIComponent(assetId) : ''}`;
}

/** @param assetId 原片。@param versionId 工作台版本。@param file 预览或下载类型。@returns 私有文件地址。 */
export function photoEditFileUrl(
  assetId: string,
  versionId: string,
  file: 'original' | 'preview' | 'image' | 'report',
) {
  return `${photoEditUrl(assetId)}/versions/${encodeURIComponent(versionId)}/files/${file}`;
}

/** @param url 同源工作台地址。@param options HTTP 参数，multipart 由浏览器设置边界。@returns 解析结果或后台诊断。 */
export async function photoEditRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(
      typeof error?.message === 'string' ? error.message : `Photo edit request failed (${response.status})`,
    );
  }
  return response.json();
}

/** 历史图中的一行，分支符号只在同一个父节点下标记兄弟关系。 */
export interface PhotoEditGraphRow {
  version: PhotoEditVersion;
  depth: number;
  last: boolean;
}

/** @param versions 按创建时间排列的完整历史。@returns 不用递归栈的深度优先视图。 */
export function photoEditGraph(versions: PhotoEditVersion[]): PhotoEditGraphRow[] {
  const byParent = new Map<string | null, PhotoEditVersion[]>();
  for (const version of versions) {
    const siblings = byParent.get(version.parentId);
    if (siblings) siblings.push(version);
    else byParent.set(version.parentId, [version]);
  }
  /** @param children 同一父节点的子版本。@param depth 它们的深度。@returns 倒序入栈的行。 */
  const rows = (children: PhotoEditVersion[], depth: number) => {
    const result: PhotoEditGraphRow[] = [];
    for (let index = children.length - 1; index >= 0; index--) {
      result.push({ version: children[index], depth, last: index === children.length - 1 });
    }
    return result;
  };
  const pending = rows(byParent.get(null) ?? [], 0);
  const result: PhotoEditGraphRow[] = [];
  for (let row = pending.pop(); row; row = pending.pop()) {
    result.push(row);
    const children = byParent.get(row.version.id);
    if (children) {
      for (const child of rows(children, row.depth + 1)) pending.push(child);
    }
  }
  return result;
}
