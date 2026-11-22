import { Injectable, Logger } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import z from 'zod';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { SceneStackReply } from 'src/dtos/scene-stack.dto.js';
import { AssetType, AssetVisibility, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { requireAccess } from 'src/utils/access.js';

const memberSchema = z.object({ id: z.uuid(), updatedAt: z.string(), stackId: z.uuid().nullable() });
const manifestSchema = z.object({
  version: z.literal(1),
  ownerId: z.uuid(),
  policy: z.string().regex(/^[a-f0-9]{64}$/),
  groups: z.array(z.object({ id: z.uuid(), coverId: z.uuid(), members: z.array(memberSchema).min(2) })),
});

/** 一个用户的已校验原子发布文件；不缓存授权结果或资产当前状态。 */
interface CachedManifest {
  signature: string;
  manifest: z.infer<typeof manifestSchema>;
}

/** 读取外部证据并逐次核对真实资产；既有时间线API、原生叠放和移动端合同均不改变。 */
@Injectable()
export class SceneStackService {
  private readonly logger = new Logger(SceneStackService.name);
  private readonly cache = new Map<string, CachedManifest>();

  /** @param assets 当前资产库。@param access 原生权限检查，不信任外部清单代替授权。 */
  constructor(
    private assets: AssetRepository,
    private access: AccessRepository,
  ) {}

  /** @param auth 当前登录。@param ids 已加载桶内ID。@returns 所有成员仍在桶内且当前有效的完整分组。 */
  async query(auth: AuthDto, ids: string[]): Promise<SceneStackReply> {
    const root = process.env.IMMICH_FORK_SCENE_STACK_DIR;
    if (!root || auth.sharedLink || ids.length === 0) {
      return { available: !!root && !auth.sharedLink, groups: [] };
    }
    const manifest = await this.readManifest(root, auth.user.id);
    if (!manifest) {
      return { available: false, groups: [] };
    }
    const requested = new Set(ids);
    const candidates = manifest.groups.filter(
      (group) =>
        group.members.some((member) => member.id === group.coverId) &&
        new Set(group.members.map((member) => member.id)).size === group.members.length &&
        group.members.every((member) => requested.has(member.id)),
    );
    const relevant = [...new Set(candidates.flatMap((group) => group.members.map((member) => member.id)))];
    if (relevant.length === 0) {
      return { available: true, groups: [] };
    }
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: relevant });
    const current = new Map((await this.assets.getByIds(relevant)).map((asset) => [asset.id, asset]));
    const used = new Set<string>();
    const groups: SceneStackReply['groups'] = [];
    for (const group of candidates) {
      // 删除、归档、离线、改图或原生叠放变化均使整组展开；不隐藏失效分组的部分照片。
      if (
        !group.members.every((member) => {
          const asset = current.get(member.id);
          return (
            asset &&
            !used.has(member.id) &&
            asset.ownerId === auth.user.id &&
            asset.type === AssetType.Image &&
            asset.visibility === AssetVisibility.Timeline &&
            !asset.deletedAt &&
            !asset.isOffline &&
            asset.stackId === member.stackId &&
            asset.updatedAt.getTime() === Date.parse(member.updatedAt)
          );
        })
      ) {
        continue;
      }
      const members = group.members.map((member) => member.id);
      members.forEach((id) => used.add(id));
      groups.push({ id: group.id, coverId: group.coverId, members });
    }
    return { available: true, groups };
  }

  /** @param root 固定服务端挂载目录。@param ownerId 登录用户UUID。@returns 已校验清单，缺失或损坏则空。 */
  private async readManifest(root: string, ownerId: string) {
    if (!z.uuid().safeParse(ownerId).success) {
      return;
    }
    try {
      const file = path.join(root, `${ownerId}.json`);
      const info = await stat(file);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) {
        return;
      }
      const signature = `${root}:${info.ino}:${info.mtimeMs}:${info.size}`;
      const cached = this.cache.get(ownerId);
      if (cached?.signature === signature) {
        return cached.manifest;
      }
      const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      if (manifest.ownerId !== ownerId) {
        return;
      }
      this.cache.set(ownerId, { signature, manifest });
      return manifest;
    } catch (error) {
      this.cache.delete(ownerId);
      this.logger.debug(`Scene manifest unavailable: ${error instanceof Error ? error.name : 'Unknown'}`);
    }
  }
}
