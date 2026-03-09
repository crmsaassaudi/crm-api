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
    const tenant = this.cls.get('tenantId');
    return this.repository.findByTenant(tenant);
  }

  getByModule(module: string): Promise<CustomField[]> {
    const tenant = this.cls.get('tenantId');
    return this.repository.findByModule(tenant, module);
  }

  async create(
    data: Omit<CustomField, 'id' | 'tenant' | 'createdAt' | 'updatedAt'>,
  ): Promise<CustomField> {
    const tenant = this.cls.get('tenantId');
    try {
      return await this.repository.create(tenant, data);
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
    const tenant = this.cls.get('tenantId');
    const updated = await this.repository.update(tenant, id, data);
    if (!updated) {
      throw new NotFoundException(`Custom field ${id} not found`);
    }
    return updated;
  }

  async remove(id: string): Promise<void> {
    const tenant = this.cls.get('tenantId');
    await this.repository.delete(tenant, id);
  }
}
