import { TemplateUsage } from '../../../../domain/template-usage';
import { TemplateUsageSchemaClass } from '../entities/template-usage.schema';

export class TemplateUsageMapper {
  static toDomain(raw: TemplateUsageSchemaClass): TemplateUsage {
    const entity = new TemplateUsage();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.templateId = raw.templateId?.toString();
    entity.variantId = raw.variantId?.toString();
    entity.channel = raw.channel as TemplateUsage['channel'];
    entity.context = raw.context as TemplateUsage['context'];
    entity.contextId = raw.contextId;
    entity.actorId = raw.actorId?.toString();
    entity.count = raw.count ?? 1;
    entity.sentAt = raw.sentAt;
    return entity;
  }
}
