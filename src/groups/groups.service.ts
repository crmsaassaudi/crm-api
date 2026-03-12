import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { GroupRepository } from './infrastructure/persistence/document/repositories/group.repository';
import { Group } from './domain/group';
import { CreateGroupDto, QueryGroupDto, UpdateGroupDto } from './dto/group.dto';

@Injectable()
export class GroupsService {
  constructor(
    private readonly repository: GroupRepository,
    private readonly cls: ClsService,
  ) {}

  async findAll(query?: QueryGroupDto): Promise<Group[]> {
    const tenant = this.cls.get('tenantId');
    return this.repository.findAll(tenant, query);
  }

  async findById(id: string): Promise<Group> {
    const tenant = this.cls.get('tenantId');
    const group = await this.repository.findById(tenant, id);
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  async create(dto: CreateGroupDto): Promise<Group> {
    const tenant = this.cls.get('tenantId');
    try {
      return await this.repository.create({ ...dto, tenant });
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
    const tenant = this.cls.get('tenantId');
    try {
      const group = await this.repository.update(tenant, id, dto);
      if (!group) throw new NotFoundException('Group not found');
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
    const tenant = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenant, id);
    if (!deleted) throw new NotFoundException('Group not found');
  }

  async addMember(groupId: string, userId: string): Promise<Group> {
    const tenant = this.cls.get('tenantId');
    const group = await this.repository.addMember(tenant, groupId, userId);
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  async removeMember(groupId: string, userId: string): Promise<Group> {
    const tenant = this.cls.get('tenantId');
    const group = await this.repository.removeMember(tenant, groupId, userId);
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }
}
