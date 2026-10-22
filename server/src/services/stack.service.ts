import { BadRequestException, Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { StackCreateDto, StackResponseDto, StackSearchDto, StackUpdateDto, mapStack } from 'src/dtos/stack.dto.js';
import { JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { findOrFail } from 'src/utils/misc.js';
import { UUIDAssetIDParamDto } from 'src/validation.js';

@Injectable()
/** 复用既有堆叠 API 与通知，为完成元数据提取的图像触发 RAW/成片归组。 */
export class StackService extends BaseService {
  /** 元数据提取完成后尝试归组；有新成员或合并堆叠时通知客户端刷新。 */
  @OnEvent({ name: 'AssetMetadataExtracted' })
  async onAssetMetadataExtracted({ assetId, userId, source, isRaw }: ArgOf<'AssetMetadataExtracted'>) {
    // 编辑侧写文件不应把用户刚拆开的堆叠自动重建。
    if (source === 'sidecar-write') {
      return;
    }
    if (
      !(isRaw ?? (await this.assetJobRepository.isRawAsset(assetId))) &&
      !(await this.assetJobRepository.isStackableImage(assetId))
    ) {
      return;
    }
    await this.jobRepository.queue({ name: JobName.AssetStackRawPair, data: { assetId, ownerId: userId } });
  }

  @OnJob({ name: JobName.AssetStackRawPair, queue: QueueName.RawPairing })
  async handleAutoStackRawPair({ assetId, ownerId }: JobOf<JobName.AssetStackRawPair>) {
    const stackId = await this.stackRepository.autoStackRawPair(assetId, ownerId);
    if (stackId) {
      await this.eventRepository.emit('StackCreate', { stackId, userId: ownerId });
    }
    return JobStatus.Success;
  }

  async search(auth: AuthDto, dto: StackSearchDto): Promise<StackResponseDto[]> {
    const stacks = await this.stackRepository.search({
      ownerId: auth.user.id,
      primaryAssetId: dto.primaryAssetId,
    });

    return stacks.map((stack) => mapStack(stack, { auth }));
  }

  async create(auth: AuthDto, dto: StackCreateDto): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds });

    const stack = await this.stackRepository.create({ ownerId: auth.user.id }, dto.assetIds);

    await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: auth.user.id });

    return mapStack(stack, { auth });
  }

  async get(auth: AuthDto, id: string): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.StackRead, ids: [id] });
    const stack = await this.findOrFail(id);
    return mapStack(stack, { auth });
  }

  async update(auth: AuthDto, id: string, dto: StackUpdateDto): Promise<StackResponseDto> {
    await this.requireAccess({ auth, permission: Permission.StackUpdate, ids: [id] });
    const stack = await this.findOrFail(id);
    if (dto.primaryAssetId && stack.assets.every(({ id }) => id !== dto.primaryAssetId)) {
      throw new BadRequestException('Primary asset must be in the stack');
    }

    const updatedStack = await this.stackRepository.update(id, { id, primaryAssetId: dto.primaryAssetId });

    await this.eventRepository.emit('StackUpdate', { stackId: id, userId: auth.user.id });

    return mapStack(updatedStack, { auth });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: [id] });
    await this.stackRepository.delete(id);
    await this.eventRepository.emit('StackDelete', { stackId: id, userId: auth.user.id });
  }

  async deleteAll(auth: AuthDto, dto: BulkIdsDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.StackDelete, ids: dto.ids });
    await this.stackRepository.deleteAll(dto.ids);
    await this.eventRepository.emit('StackDeleteAll', { stackIds: dto.ids, userId: auth.user.id });
  }

  async removeAsset(auth: AuthDto, dto: UUIDAssetIDParamDto): Promise<void> {
    const { id: stackId, assetId } = dto;
    await this.requireAccess({ auth, permission: Permission.StackUpdate, ids: [stackId] });

    const stack = await this.stackRepository.getForAssetRemoval(assetId);

    if (!stack?.id || stack.id !== stackId) {
      throw new BadRequestException('Asset not in stack');
    }

    if (stack.primaryAssetId === assetId) {
      throw new BadRequestException("Cannot remove stack's primary asset");
    }

    await this.assetRepository.update({ id: assetId, stackId: null });
    await this.eventRepository.emit('StackUpdate', { stackId, userId: auth.user.id });
  }

  private findOrFail(id: string) {
    return findOrFail(() => this.stackRepository.getById(id), 'Asset stack');
  }
}
