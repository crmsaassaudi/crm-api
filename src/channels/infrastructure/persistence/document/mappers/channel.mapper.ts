import { Channel } from '../../../../domain/channel';
import { ChannelSchemaClass } from '../entities/channel.schema';

export class ChannelMapper {
  static toDomain(raw: ChannelSchemaClass): Channel {
    const entity = new Channel();
    entity.id = raw._id?.toString();
    entity.tenant = raw.tenant;
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
}
