import { Channel } from '../../../../domain/channel';
import { ChannelSchemaClass } from '../entities/channel.schema';

export class ChannelMapper {
  static toDomain(raw: ChannelSchemaClass): Channel {
    const entity = new Channel();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.type = raw.type;
    entity.name = raw.name;
    entity.account = raw.account;
    entity.status = raw.status;
    entity.config = raw.config;
    if (raw.credentials) {
      entity.credentials = raw.credentials;
    }
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  static toPersistence(entity: Channel): Partial<ChannelSchemaClass> {
    const p: any = {};
    if (entity.id) p._id = entity.id;
    p.tenantId = entity.tenantId;
    p.type = entity.type;
    p.name = entity.name;
    p.account = entity.account;
    p.status = entity.status;
    p.config = entity.config;
    if (entity.credentials) p.credentials = entity.credentials;
    return p;
  }
}