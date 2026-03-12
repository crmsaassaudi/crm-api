import { CannedResponse } from '../../../../domain/canned-response';
import { CannedResponseSchemaClass } from '../entities/canned-response.schema';

export class CannedResponseMapper {
  static toDomain(raw: CannedResponseSchemaClass): CannedResponse {
    const entity = new CannedResponse();
    entity.id = raw._id?.toString();
    entity.tenant = raw.tenant;
    entity.shortcut = raw.shortcut;
    entity.content = raw.content;
    entity.category = raw.category;
    entity.scope = raw.scope;
    entity.createdBy = raw.createdBy;
    entity.attachments = raw.attachments;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }
}
