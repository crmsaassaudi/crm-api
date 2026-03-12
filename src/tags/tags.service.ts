import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { TagRepository } from './infrastructure/persistence/document/repositories/tag.repository';
import { Tag } from './domain/tag';
import { CreateTagDto, UpdateTagDto } from './dto/tag.dto';

@Injectable()
export class TagsService {
  constructor(
    private readonly repository: TagRepository,
    private readonly cls: ClsService,
  ) {}

  async findAll(query?: { scope?: string; search?: string }): Promise<Tag[]> {
    const tenant = this.cls.get('tenantId');
    return this.repository.findAll(tenant, query);
  }

  async findById(id: string): Promise<Tag> {
    const tenant = this.cls.get('tenantId');
    const tag = await this.repository.findById(tenant, id);
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  async create(dto: CreateTagDto): Promise<Tag> {
    const tenant = this.cls.get('tenantId');
    return this.repository.create({ ...dto, tenant });
  }

  async update(id: string, dto: UpdateTagDto): Promise<Tag> {
    const tenant = this.cls.get('tenantId');
    const tag = await this.repository.update(tenant, id, dto);
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  async delete(id: string): Promise<void> {
    const tenant = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenant, id);
    if (!deleted) throw new NotFoundException('Tag not found');
  }
}
