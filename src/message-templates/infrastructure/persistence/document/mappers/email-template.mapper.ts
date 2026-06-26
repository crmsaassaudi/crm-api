import { EmailTemplate } from '../../../../domain/email-template';
import { EmailTemplateSchemaClass } from '../entities/email-template.schema';

export class EmailTemplateMapper {
  static toDomain(raw: EmailTemplateSchemaClass): EmailTemplate {
    const entity = new EmailTemplate();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.subject = raw.subject;
    entity.htmlContent = raw.htmlContent;
    entity.designJson = raw.designJson;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(entity: EmailTemplate): Partial<EmailTemplateSchemaClass> {
    const p: any = {};
    if (entity.id) p._id = entity.id;
    p.tenantId = entity.tenantId;
    p.name = entity.name;
    p.subject = entity.subject;
    p.htmlContent = entity.htmlContent;
    p.designJson = entity.designJson;
    return p;
  }
}