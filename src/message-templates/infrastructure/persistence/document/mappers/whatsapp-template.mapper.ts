import { WhatsAppTemplate } from '../../../../domain/whatsapp-template';
import { WhatsAppTemplateSchemaClass } from '../entities/whatsapp-template.schema';

export class WhatsAppTemplateMapper {
  static toDomain(raw: WhatsAppTemplateSchemaClass): WhatsAppTemplate {
    const entity = new WhatsAppTemplate();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.category = raw.category;
    entity.language = raw.language;
    entity.status = raw.status;
    entity.metaTemplateId = raw.metaTemplateId;
    entity.components = raw.components;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }
}
