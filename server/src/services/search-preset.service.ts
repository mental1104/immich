import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { SearchPresetDto } from 'src/dtos/search-preset.dto.js';
import { SearchPresetRepository } from 'src/repositories/search-preset.repository.js';

/** 处理个人条件登记的冲突和资源不存在语义；不执行搜索或绕过资产权限。 */
@Injectable()
export class SearchPresetService {
  /** @param repository 按用户隔离的登记存储。 */
  constructor(private readonly repository: SearchPresetRepository) {}
  /** @param userId 当前账号。@returns 当前账号的登记项。 */
  getAll(userId: string) {
    return this.repository.getAll(userId);
  }
  /** @param userId 当前账号。@param dto 新名称/条件。@returns 新项；重名409。 */
  async create(userId: string, dto: SearchPresetDto) {
    const preset = await this.repository.create(userId, dto);
    if (!preset) throw new ConflictException('Search preset name already exists');
    return preset;
  }
  /** @param userId 当前账号。@param id 自有项ID。@param dto 新值。@returns 修改结果；不存在404，重名409。 */
  async update(userId: string, id: string, dto: SearchPresetDto) {
    try {
      const preset = await this.repository.update(userId, id, dto);
      if (!preset) throw new NotFoundException('Search preset not found');
      return preset;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
        throw new ConflictException('Search preset name already exists');
      throw error;
    }
  }
  /** @param userId 当前账号。@param id 自有项ID。@returns 删除完成；不存在404。 */
  async delete(userId: string, id: string): Promise<void> {
    if (!(await this.repository.delete(userId, id))) throw new NotFoundException('Search preset not found');
  }
}
