import { RichMessageTemplateSchemaDocument } from '../entities/rich-message-template.schema';
import { RichMessageTemplate } from '../../../../domain/rich-message-template';

export class RichMessageTemplateMapper {
  static toDomain(doc: RichMessageTemplateSchemaDocument): RichMessageTemplate {
    const entity = new RichMessageTemplate();
    entity.id = doc._id?.toString();
    entity.tenantId = doc.tenantId;
    entity.name = doc.name;
    entity.shortcut = doc.shortcut;
    entity.type = doc.type as 'interactive' | 'carousel';
    entity.channelTypes = doc.channelTypes;
    entity.body = doc.body;
    entity.buttons = doc.buttons;
    entity.cards = doc.cards;
    entity.scope = doc.scope;
    entity.createdById = doc.createdById;
    entity.isActive = doc.isActive;
    entity.createdAt = (doc as any).createdAt;
    entity.updatedAt = (doc as any).updatedAt;
    return entity;
  }
}
