import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GroupRepository } from './infrastructure/persistence/document/repositories/group.repository';
import { Group } from './domain/group';
import { CreateGroupDto, QueryGroupDto, UpdateGroupDto } from './dto/group.dto';
import { UserRepository } from '../users/infrastructure/persistence/user.repository';

@Injectable()
export class GroupsService {
  constructor(
    private readonly repository: GroupRepository,
    private readonly cls: ClsService,
    private readonly userRepository: UserRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async findAll(query?: QueryGroupDto): Promise<Group[]> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.findAll(tenantId, query);
  }

  async findById(id: string): Promise<Group> {
    const tenantId = this.cls.get('tenantId');
    const group = await this.repository.findById(tenantId, id);
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  async create(dto: CreateGroupDto): Promise<Group> {
    const tenantId = this.cls.get('tenantId');
    try {
      const group = await this.repository.create({ ...dto, tenantId });
      this.emitGroupUpdated(tenantId, group);
      return group;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          `A group named "${dto.name}" already exists in this tenant`,
        );
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateGroupDto): Promise<Group> {
    const tenantId = this.cls.get('tenantId');
    try {
      const previous = await this.repository.findById(tenantId, id);
      const group = await this.repository.update(tenantId, id, dto);
      if (!group) throw new NotFoundException('Group not found');
      this.emitGroupUpdated(tenantId, group, previous?.memberIds);
      return group;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          `A group named "${dto.name}" already exists in this tenant`,
        );
      }
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const previous = await this.repository.findById(tenantId, id);
    const deleted = await this.repository.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Group not found');
    if (previous) this.emitGroupUpdated(tenantId, previous);
  }

  async addMember(groupId: string, userId: string): Promise<Group> {
    const tenantId = this.cls.get('tenantId');

    // Validate user belongs to this tenant before adding to group
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const belongsToTenant = user.tenants?.some(
      (t) => t.tenantId?.toString() === tenantId.toString(),
    );
    if (!belongsToTenant) {
      throw new UnprocessableEntityException(
        'User must belong to this tenant before being added to a group',
      );
    }

    const group = await this.repository.addMember(tenantId, groupId, userId);
    if (!group) throw new NotFoundException('Group not found');
    this.eventEmitter.emit('group.membership.updated', {
      tenantId,
      groupId,
      memberIds: [userId],
    });
    return group;
  }

  async removeMember(groupId: string, userId: string): Promise<Group> {
    const tenantId = this.cls.get('tenantId');
    const group = await this.repository.removeMember(tenantId, groupId, userId);
    if (!group) throw new NotFoundException('Group not found');
    this.eventEmitter.emit('group.membership.updated', {
      tenantId,
      groupId,
      memberIds: [userId],
    });
    return group;
  }

  private emitGroupUpdated(
    tenantId: string,
    group: Group,
    previousMemberIds: string[] = [],
  ): void {
    const memberIds = Array.from(
      new Set([...(group.memberIds ?? []), ...previousMemberIds].map(String)),
    );

    this.eventEmitter.emit('group.updated', {
      tenantId,
      groupId: group.id,
      memberIds,
    });
  }
}
