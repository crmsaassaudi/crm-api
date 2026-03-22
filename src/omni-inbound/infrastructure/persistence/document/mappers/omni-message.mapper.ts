import { OmniMessage } from '../../../../domain/omni-message';
import { OmniMessageSchemaClass } from '../entities/omni-message.schema';

export class OmniMessageMapper {
  static toDomain(raw: OmniMessageSchemaClass): OmniMessage {
    return {
      id: raw._id.toString(),
      tenantId: raw.tenant?.toString(),
      conversationId: raw.conversation?.toString(),
      senderId: raw.senderId,
      senderType: raw.senderType as any,
      messageType: raw.messageType as any,
      content: raw.content,
      mediaUrl: raw.mediaUrl,
      mediaProxyUrl: raw.mediaProxyUrl,
      status: raw.status as any,
      metadata: raw.metadata,
      externalMessageId: raw.externalMessageId,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  static toPersistence(domain: OmniMessage): OmniMessageSchemaClass {
    const raw = new OmniMessageSchemaClass();
    if (domain.id) {
      raw._id = domain.id;
    }
    raw.tenant = domain.tenantId;
    raw.conversation = domain.conversationId;
    raw.senderId = domain.senderId;
    raw.senderType = domain.senderType;
    raw.messageType = domain.messageType;
    raw.content = domain.content;
    raw.mediaUrl = domain.mediaUrl as string;
    raw.mediaProxyUrl = domain.mediaProxyUrl as string;
    raw.status = domain.status;
    raw.metadata = domain.metadata as Record<string, any>;
    raw.externalMessageId = domain.externalMessageId as string;
    
    return raw;
  }
}
