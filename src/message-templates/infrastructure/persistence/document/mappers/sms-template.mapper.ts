import { SMSTemplate } from '../../../../domain/sms-template';
import { SMSTemplateSchemaClass } from '../entities/sms-template.schema';

export class SMSTemplateMapper {
  static toDomain(raw: SMSTemplateSchemaClass): SMSTemplate {
    const entity = new SMSTemplate();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.message = raw.message;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(entity: SMSTemplate): Partial<SMSTemplateSchemaClass> {
    const p: any = {};
    if (entity.id) p._id = entity.id;
    p.tenantId = entity.tenantId;
    p.name = entity.name;
    p.message = entity.message;
    return p;
  }
}
