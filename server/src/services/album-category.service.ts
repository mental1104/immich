import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DEFAULT_ALBUM_CATEGORY_NAME, type AlbumGroupCategoryDto } from 'src/dtos/album-category.dto.js';
import { AlbumCategoryRepository } from 'src/repositories/album-category.repository.js';

/** 可选大组目录服务；所有操作均从认证身份取得用户ID，保留原有分组及资产关系。 */
@Injectable()
export class AlbumCategoryService {
  /** @param repository 用户隔离的大组持久化访问。 */
  constructor(private readonly repository: AlbumCategoryRepository) {}

  /** @param userId 当前用户。@returns 大组和可见分组映射，旧数据没有映射即默认。 */
  getState(userId: string) {
    return this.repository.getState(userId);
  }

  /** @param userId 当前用户。@param name 新大组名称。@returns 新建大组；重名报409。 */
  async create(userId: string, name: string) {
    this.validateName(name);
    const category = await this.repository.create(userId, name);
    if (!category) throw new ConflictException('Album category name already exists');
    return category;
  }

  /** @param userId 当前用户。@param id 自有大组。@param name 新名称。@returns 改名后的大组。 */
  async rename(userId: string, id: string, name: string) {
    this.validateName(name);
    try {
      const category = await this.repository.rename(userId, id, name);
      if (!category) throw new NotFoundException('Album category not found');
      return category;
    } catch (error) {
      // 名称唯一性由数据库最终裁决，同时改名时也必须稳定返回409，而非检查后竞争导致500。
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new ConflictException('Album category name already exists');
      }
      throw error;
    }
  }

  /** @param userId 当前用户。@param id 自有大组。@returns 删除完成；分组归属随之回默认。 */
  async delete(userId: string, id: string): Promise<void> {
    if (!(await this.repository.delete(userId, id))) throw new NotFoundException('Album category not found');
  }

  /** @param userId 当前用户。@param dto 可见分组及可选父节点。@returns 设置完成。 */
  async assign(userId: string, dto: AlbumGroupCategoryDto): Promise<void> {
    if (!(await this.repository.assign(userId, dto.groupName, dto.categoryId))) {
      throw new NotFoundException('Album group or category not found');
    }
  }

  /** @param name 已由DTO校验的名称。@returns 无；系统默认名称不能创建为实体大组。 */
  private validateName(name: string): void {
    if (name === DEFAULT_ALBUM_CATEGORY_NAME) throw new BadRequestException('Default album category is virtual');
  }
}
