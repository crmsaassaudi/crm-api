import { CannedResponse } from '../../../../domain/canned-response';
import { CannedResponseSchemaClass } from '../entities/canned-response.schema';

export class CannedResponseMapper {
  static toDomain(raw: CannedResponseSchemaClass): CannedResponse {
    const entity = new CannedResponse();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.shortcut = raw.shortcut;
    entity.content = raw.content;
    entity.category = raw.category;
    entity.scope = raw.scope;
    entity.createdById = raw.createdById?.toString();
    entity.attachments = raw.attachments;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(entity: CannedResponse): Partial<CannedResponseSchemaClass> {
    const p: any = {};
    if (entity.id) p._id = entity.id;
    p.tenantId = entity.tenantId;
    p.shortcut = entity.shortcut;
    p.content = entity.content;
    p.category = entity.category;
    p.scope = entity.scope;
    p.createdById = entity.createdById;
    p.attachments = entity.attachments;
    return p;
  }
}