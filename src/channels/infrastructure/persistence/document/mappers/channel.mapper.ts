import {
  Channel,
  ChannelSupport,
  ChannelVisibility,
  DEFAULT_CHANNEL_SUPPORT,
} from '../../../../domain/channel';
import { ChannelSchemaClass } from '../entities/channel.schema';

/**
 * Normalize the stored support subdocument into plain string ids. Documents
 * created before the field existed have it undefined, so callers can rely on
 * `channel.support` always being present and never having to null-check.
 */
function toDomainSupport(raw: ChannelSchemaClass['support']): ChannelSupport {
  if (!raw) return { ...DEFAULT_CHANNEL_SUPPORT };
  return {
    userIds: (raw.userIds ?? []).map(String),
    groupIds: (raw.groupIds ?? []).map(String),
    excludedUserIds: (raw.excludedUserIds ?? []).map(String),
    mode: raw.mode === 'restricted' ? 'restricted' : 'open',
  };
}

function toDomainVisibility(
  raw: ChannelSchemaClass['visibility'],
): ChannelVisibility {
  return raw === 'private' || raw === 'public_read' ? raw : 'inherit';
}

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
    entity.support = toDomainSupport(raw.support);
    entity.visibility = toDomainVisibility(raw.visibility);
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
    if (entity.support) p.support = entity.support;
    if (entity.visibility) p.visibility = entity.visibility;
    if (entity.credentials) p.credentials = entity.credentials;
    return p;
  }
}
