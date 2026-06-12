import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CustomFieldRepository } from './infrastructure/persistence/document/repositories/custom-field.repository';
import { CustomField } from './domain/custom-field';

@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly repository: CustomFieldRepository,
    private readonly cls: ClsService,
  ) {}

  getAll(): Promise<CustomField[]> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.findByTenant(tenantId);
  }

  getByModule(module: string): Promise<CustomField[]> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.findByModule(tenantId, module);
  }

  async create(
    data: Omit<CustomField, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>,
  ): Promise<CustomField> {
    const tenantId = this.cls.get('tenantId');
    try {
      return await this.repository.create(tenantId, data);
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          `A field with internalKey "${data.internalKey}" already exists for module "${data.module}"`,
        );
      }
      throw err;
    }
  }

  async update(id: string, data: Partial<CustomField>): Promise<CustomField> {
    const tenantId = this.cls.get('tenantId');
    const updated = await this.repository.update(tenantId, id, data);
    if (!updated) {
      throw new NotFoundException(`Custom field ${id} not found`);
    }
    return updated;
  }

  async remove(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    // Soft-delete: flip isActive=false instead of hard-removing the document.
    // Hard delete orphaned per-record customField values and freed the unique
    // internalKey for reuse, which silently re-bound stale data. The unique
    // index on (tenantId, internalKey, module) intentionally still covers
    // soft-deleted rows, so a retired key cannot be recreated.
    const updated = await this.repository.update(tenantId, id, {
      isActive: false,
    });
    if (!updated) {
      throw new NotFoundException(`Custom field ${id} not found`);
    }
  }
}
