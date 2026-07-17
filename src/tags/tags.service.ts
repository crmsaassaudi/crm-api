import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { TagRepository } from './infrastructure/persistence/document/repositories/tag.repository';
import { TagUsageService } from './tag-usage.service';
import { Tag } from './domain/tag';
import { CreateTagDto, UpdateTagDto } from './dto/tag.dto';

@Injectable()
export class TagsService {
  constructor(
    private readonly repository: TagRepository,
    private readonly usage: TagUsageService,
    private readonly cls: ClsService,
  ) {}

  async findAll(query?: { scope?: string; search?: string }): Promise<Tag[]> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.findAll(tenantId, query);
  }

  async findById(id: string): Promise<Tag> {
    const tenantId = this.cls.get('tenantId');
    const tag = await this.repository.findById(tenantId, id);
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  async create(dto: CreateTagDto): Promise<Tag> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.create({ ...dto, tenantId });
  }

  async update(id: string, dto: UpdateTagDto): Promise<Tag> {
    const tenantId = this.cls.get('tenantId');
    const tag = await this.repository.update(tenantId, id, dto);
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const tag = await this.repository.findById(tenantId, id);
    if (!tag) throw new NotFoundException('Tag not found');
    await this.usage.removeReferences(tenantId, tag.scope, id);
    const deleted = await this.repository.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Tag not found');
  }

  async getUsageCount(id: string): Promise<number> {
    const tenantId = this.cls.get('tenantId');
    const tag = await this.repository.findById(tenantId, id);
    if (!tag) throw new NotFoundException('Tag not found');
    return this.usage.countUsage(tenantId, tag.scope, id);
  }

  async reorder(scope: string, orderedIds: string[]): Promise<Tag[]> {
    const tenantId = this.cls.get('tenantId');
    await this.repository.reorder(tenantId, scope, orderedIds);
    return this.repository.findAll(tenantId, { scope });
  }

  /** Throws if any id doesn't correspond to a catalog tag of the given scope for this tenant. */
  async validateTagIds(scope: string, tagIds: string[]): Promise<void> {
    const uniqueIds = Array.from(new Set(tagIds.filter(Boolean)));
    if (!uniqueIds.length) return;
    const tenantId = this.cls.get('tenantId');
    const found = await this.repository.findByIds(tenantId, scope, uniqueIds);
    if (found.length !== uniqueIds.length) {
      const foundIds = new Set(found.map((t) => t.id));
      const missing = uniqueIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Unknown ${scope} tag id(s): ${missing.join(', ')}`,
      );
    }
  }

  /** Resolves a list of tag names to catalog ids for the given scope, creating any that don't exist yet. */
  async resolveOrCreateByNames(
    scope: string,
    names: string[],
  ): Promise<Map<string, string>> {
    const tenantId = this.cls.get('tenantId');
    const result = new Map<string, string>();
    for (const rawName of names) {
      const name = rawName.trim();
      if (!name) continue;
      if (result.has(name)) continue;
      const existing = await this.repository.findByExactName(
        tenantId,
        scope,
        name,
      );
      if (existing) {
        result.set(name, existing.id);
        continue;
      }
      const created = await this.repository.create({
        tenantId,
        name,
        scope,
        color: '#6b7280',
        order: 0,
        channelIds: [],
      });
      result.set(name, created.id);
    }
    return result;
  }

  async merge(id: string, targetTagId: string): Promise<void> {
    if (id === targetTagId) {
      throw new BadRequestException('Cannot merge a tag into itself');
    }
    const tenantId = this.cls.get('tenantId');
    const source = await this.repository.findById(tenantId, id);
    if (!source) throw new NotFoundException('Tag not found');
    const target = await this.repository.findById(tenantId, targetTagId);
    if (!target) throw new NotFoundException('Target tag not found');
    if (target.scope !== source.scope) {
      throw new BadRequestException(
        'Can only merge tags that share the same scope',
      );
    }
    await this.usage.reassignReferences(
      tenantId,
      source.scope,
      id,
      targetTagId,
    );
    await this.repository.delete(tenantId, id);
  }
}
