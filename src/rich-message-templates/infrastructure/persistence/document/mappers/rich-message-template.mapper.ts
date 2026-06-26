import {
  RichMessageTemplateSchemaClass,
  RichMessageTemplateSchemaDocument,
} from '../entities/rich-message-template.schema';
import { RichMessageTemplate } from '../../../../domain/rich-message-template';

export class RichMessageTemplateMapper {
  static toDomain(raw: RichMessageTemplateSchemaDocument): RichMessageTemplate {
    const entity = new RichMessageTemplate();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.shortcut = raw.shortcut;
    entity.type = raw.type as 'interactive' | 'carousel';
    entity.channelTypes = raw.channelTypes;
    entity.body = raw.body;
    entity.buttons = (raw.buttons ?? []).map((b) => ({
      id: String((b as any).id ?? (b as any)._id ?? ''),
      title: b.title,
    }));
    entity.cards = (raw.cards ?? []).map((c) => ({
      title: c.title,
      subtitle: c.subtitle,
      imageUrl: c.imageUrl,
      buttons: (c.buttons ?? []).map((b) => ({
        id: String((b as any).id ?? (b as any)._id ?? ''),
        title: b.title,
      })),
    }));
    entity.scope = raw.scope;
    entity.createdById = (raw as any).createdById?.toString();
    entity.isActive = raw.isActive;
    entity.createdAt = (raw as any).createdAt;
    entity.updatedAt = (raw as any).updatedAt;
    return entity;
  }

  static toPersistence(
    entity: RichMessageTemplate,
  ): Partial<RichMessageTemplateSchemaClass> {
    const persistence: any = {};
    if (entity.id) {
      persistence._id = entity.id;
    }
    persistence.tenantId = entity.tenantId;
    persistence.name = entity.name;
    persistence.shortcut = entity.shortcut ?? '';
    persistence.type = entity.type;
    persistence.channelTypes = entity.channelTypes;
    persistence.body = entity.body ?? '';
    persistence.buttons = (entity.buttons ?? []).map((b) => ({
      id: b.id,
      title: b.title,
    }));
    persistence.cards = (entity.cards ?? []).map((c) => ({
      title: c.title,
      subtitle: c.subtitle,
      imageUrl: c.imageUrl,
      buttons: (c.buttons ?? []).map((b) => ({ id: b.id, title: b.title })),
    }));
    persistence.scope = entity.scope;
    persistence.createdById = entity.createdById;
    persistence.isActive = entity.isActive ?? true;
    return persistence;
  }
}
