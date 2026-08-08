import { MessageTemplate } from '../../../../domain/message-template';
import { MessageTemplateSchemaClass } from '../entities/message-template.schema';

export class MessageTemplateMapper {
  static toDomain(raw: MessageTemplateSchemaClass): MessageTemplate {
    const entity = new MessageTemplate();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.purpose = raw.purpose as MessageTemplate['purpose'];
    entity.tags = raw.tags ?? [];
    entity.status = raw.status as MessageTemplate['status'];
    entity.visibility = raw.visibility as MessageTemplate['visibility'];
    entity.ownerId = raw.ownerId?.toString();
    entity.shortcut = raw.shortcut;
    entity.usageCount = raw.usageCount ?? 0;
    entity.lastUsedAt = raw.lastUsedAt;
    entity.deletedAt = raw.deletedAt ?? null;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(
    entity: Partial<MessageTemplate>,
  ): Partial<MessageTemplateSchemaClass> {
    const p: any = {};
    if (entity.tenantId !== undefined) p.tenantId = entity.tenantId;
    if (entity.name !== undefined) p.name = entity.name;
    if (entity.purpose !== undefined) p.purpose = entity.purpose;
    if (entity.tags !== undefined) p.tags = entity.tags;
    if (entity.status !== undefined) p.status = entity.status;
    if (entity.visibility !== undefined) p.visibility = entity.visibility;
    if (entity.ownerId !== undefined) p.ownerId = entity.ownerId;
    if (entity.shortcut !== undefined) p.shortcut = entity.shortcut;
    return p;
  }
}
