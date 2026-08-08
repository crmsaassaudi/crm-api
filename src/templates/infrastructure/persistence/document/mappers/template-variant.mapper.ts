import { TemplateVariant } from '../../../../domain/template-variant';
import { TemplateVariantSchemaClass } from '../entities/template-variant.schema';

export class TemplateVariantMapper {
  static toDomain(raw: TemplateVariantSchemaClass): TemplateVariant {
    const entity = new TemplateVariant();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.templateId = raw.templateId?.toString();
    entity.channel = raw.channel as TemplateVariant['channel'];
    entity.locale = raw.locale;
    entity.contentType = raw.contentType as TemplateVariant['contentType'];
    entity.subject = raw.subject;
    entity.body = raw.body;
    entity.htmlContent = raw.htmlContent;
    entity.designJson = raw.designJson;
    entity.buttons = raw.buttons;
    entity.cards = raw.cards;
    entity.attachments = raw.attachments;
    entity.providerBinding = raw.providerBinding as any;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(
    entity: Partial<TemplateVariant>,
  ): Partial<TemplateVariantSchemaClass> {
    const p: any = {};
    if (entity.tenantId !== undefined) p.tenantId = entity.tenantId;
    if (entity.templateId !== undefined) p.templateId = entity.templateId;
    if (entity.channel !== undefined) p.channel = entity.channel;
    if (entity.locale !== undefined) p.locale = entity.locale;
    if (entity.contentType !== undefined) p.contentType = entity.contentType;
    if (entity.subject !== undefined) p.subject = entity.subject;
    if (entity.body !== undefined) p.body = entity.body;
    if (entity.htmlContent !== undefined) p.htmlContent = entity.htmlContent;
    if (entity.designJson !== undefined) p.designJson = entity.designJson;
    if (entity.buttons !== undefined) p.buttons = entity.buttons;
    if (entity.cards !== undefined) p.cards = entity.cards;
    if (entity.attachments !== undefined) p.attachments = entity.attachments;
    if (entity.providerBinding !== undefined)
      p.providerBinding = entity.providerBinding;
    return p;
  }
}
