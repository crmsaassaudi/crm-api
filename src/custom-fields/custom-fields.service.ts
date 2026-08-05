import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { CustomFieldRepository } from './infrastructure/persistence/document/repositories/custom-field.repository';
import { CustomField } from './domain/custom-field';
import {
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
} from './dto/custom-field.dto';
import {
  STANDARD_FIELDS,
  isConfigurableObject,
} from '../object-manager/object-registry';

/**
 * Upper bound on custom fields per object.
 *
 * Every one of them is loaded on each `/me/object-config` read, embedded in the
 * export column plan, and considered by `CustomFieldValueValidator` on every write.
 * There was no bound at all, so a scripted integration could grow the per-object
 * catalog without limit and make those three paths progressively slower for the
 * whole tenant. 300 is far above any hand-built configuration.
 */
const MAX_FIELDS_PER_OBJECT = 300;

@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly repository: CustomFieldRepository,
    private readonly cls: ClsService,
    private readonly events: EventEmitter2,
  ) {}

  getAll(): Promise<CustomField[]> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.findByTenant(tenantId);
  }

  getByModule(module: string): Promise<CustomField[]> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.findByModule(tenantId, module);
  }

  async create(data: CreateCustomFieldDto): Promise<CustomField> {
    const tenantId = this.cls.get('tenantId');

    this.assertKeyDoesNotShadowStandardField(data.module, data.internalKey);
    await this.assertUnderFieldLimit(tenantId, data.module);

    try {
      const created = await this.repository.create(tenantId, data as any);
      this.emitConfigUpdated(tenantId, data.module);
      return created;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          `A field with internalKey "${data.internalKey}" already exists for module "${data.module}"`,
        );
      }
      throw err;
    }
  }

  async update(id: string, data: UpdateCustomFieldDto): Promise<CustomField> {
    const tenantId = this.cls.get('tenantId');
    const updated = await this.repository.update(tenantId, id, data);
    if (!updated) {
      throw new NotFoundException(`Custom field ${id} not found`);
    }
    this.emitConfigUpdated(tenantId, updated.module);
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
    this.emitConfigUpdated(tenantId, updated.module);
  }

  /**
   * A custom field must not take the name of a standard payload property.
   *
   * Custom values live in the `customFields` sub-document, so `customFields.emails`
   * and the top-level `emails` never actually collide in storage — but they collide
   * everywhere a key is read as an identity: a layout entry, a validation rule and
   * a masking policy all say `emails` and cannot say which one they mean. The
   * registry resolves standard keys first, so the custom field would simply never
   * be the one addressed. Refusing the name is clearer than shipping a field whose
   * settings silently govern something else.
   */
  private assertKeyDoesNotShadowStandardField(
    module: string,
    internalKey: string,
  ): void {
    if (!isConfigurableObject(module)) return;

    const clash = STANDARD_FIELDS[module].some(
      (field) =>
        field.key === internalKey ||
        field.column === internalKey ||
        field.legacyAliases?.includes(internalKey),
    );

    if (clash) {
      throw new BadRequestException(
        `"${internalKey}" is a standard ${module} field. Choose another internalKey.`,
      );
    }
  }

  private async assertUnderFieldLimit(
    tenantId: string,
    module: string,
  ): Promise<void> {
    const existing = await this.repository.countByModule(tenantId, module);
    if (existing >= MAX_FIELDS_PER_OBJECT) {
      throw new BadRequestException(
        `${module} already has the maximum of ${MAX_FIELDS_PER_OBJECT} custom fields. Retire an unused field first.`,
      );
    }
  }

  /**
   * Tell the Redis-backed label cache that this module's fields changed.
   *
   * `CustomFieldsCacheInvalidationListener` has existed for this event and nothing
   * emitted it, so a renamed field kept its old label in audit entries for the full
   * five-minute TTL — the exact staleness the listener was written to remove.
   */
  private emitConfigUpdated(tenantId: string, entityType: string): void {
    this.events.emit('custom_field.config_updated', { tenantId, entityType });
  }
}
