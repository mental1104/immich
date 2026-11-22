import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetType, AssetVisibility, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { SceneStackService } from 'src/services/scene-stack.service.js';
import { requireAccess } from 'src/utils/access.js';

vi.mock('src/repositories/access.repository.js', () => ({ AccessRepository: class {} }));
vi.mock('src/repositories/asset.repository.js', () => ({ AssetRepository: class {} }));
vi.mock('src/utils/access.js', () => ({ requireAccess: vi.fn() }));

/** 用真实原子清单文件验证外部证据失效及权限边界，资产查询由独立替身控制。 */
describe(SceneStackService.name, () => {
  const ownerId = '00000000-0000-4000-8000-000000000001';
  const ids = ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
  const auth = { user: { id: ownerId } } as AuthDto;
  const updatedAt = new Date('2026-01-01T00:00:00Z');
  let root: string;
  let service: SceneStackService;
  let assets: Array<{
    id: string;
    ownerId: string;
    updatedAt: Date;
    stackId: string | null;
    type: AssetType;
    visibility: AssetVisibility;
    deletedAt: Date | null;
    isOffline: boolean;
  }>;
  const getByIds = vi.fn();

  /** @returns 将真实格式的有效分组写到本轮隔离目录。 */
  async function publish(): Promise<void> {
    await writeFile(
      path.join(root, `${ownerId}.json`),
      JSON.stringify({
        version: 1,
        ownerId,
        policy: 'a'.repeat(64),
        groups: [
          {
            id: '00000000-0000-4000-8000-000000000004',
            coverId: ids[0],
            members: ids.map((id) => ({ id, updatedAt: updatedAt.toISOString(), stackId: null })),
          },
        ],
      }),
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'immich-scenes-'));
    vi.stubEnv('IMMICH_FORK_SCENE_STACK_DIR', root);
    vi.mocked(requireAccess).mockReset().mockResolvedValue();
    assets = ids.map((id) => ({
      id,
      ownerId,
      updatedAt,
      stackId: null,
      type: AssetType.Image,
      visibility: AssetVisibility.Timeline,
      deletedAt: null,
      isOffline: false,
    }));
    getByIds.mockReset().mockImplementation(() => Promise.resolve(assets));
    service = new SceneStackService({ getByIds } as unknown as AssetRepository, {} as AccessRepository);
    await publish();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('returns a complete current group only after native permission checks', async () => {
    expect((await service.query(auth, ids)).groups[0].members).toEqual(ids);
    expect(requireAccess).toHaveBeenCalledWith(expect.anything(), { auth, permission: Permission.AssetRead, ids });
    expect((await service.query(auth, [ids[0]])).groups).toEqual([]);
  });
  it.each(['owner', 'revision', 'stack', 'deleted', 'offline', 'archive', 'missing'])(
    'unfolds the entire group after %s changes',
    async (change) => {
      if (change === 'owner') assets[1].ownerId = ids[0];
      if (change === 'revision') assets[1].updatedAt = new Date(updatedAt.getTime() + 1);
      if (change === 'stack') assets[1].stackId = ids[0];
      if (change === 'deleted') assets[1].deletedAt = updatedAt;
      if (change === 'offline') assets[1].isOffline = true;
      if (change === 'archive') assets[1].visibility = AssetVisibility.Archive;
      if (change === 'missing') assets.pop();
      expect((await service.query(auth, ids)).groups).toEqual([]);
    },
  );
  it('rejects denied access and excludes shared-link contexts', async () => {
    vi.mocked(requireAccess).mockRejectedValue(new Error('Denied'));
    await expect(service.query(auth, ids)).rejects.toThrow('Denied');
    expect(getByIds).not.toHaveBeenCalled();
    expect((await service.query({ ...auth, sharedLink: {} as AuthDto['sharedLink'] }, ids)).groups).toEqual([]);
  });
  it('falls back without hiding assets when the manifest is unavailable or corrupt', async () => {
    await writeFile(path.join(root, `${ownerId}.json`), 'broken');
    expect((await service.query(auth, ids)).groups).toEqual([]);
    await rm(path.join(root, `${ownerId}.json`));
    expect((await service.query(auth, ids)).groups).toEqual([]);
  });
});
