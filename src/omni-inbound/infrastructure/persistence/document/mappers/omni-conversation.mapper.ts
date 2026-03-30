import { OmniConversation } from '../../../../domain/omni-conversation';
import { OmniConversationSchemaClass } from '../entities/omni-conversation.schema';
import { ChannelType } from '../../../../domain/omni-payload';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class OmniConversationMapper {
  static toDomain(raw: OmniConversationSchemaClass): OmniConversation {
    const assignedAgentObj = (raw as any).assignedAgent
      ? UserMapper.toDomain((raw as any).assignedAgent)
      : undefined;
    const resolvedByAgentObj = (raw as any).resolvedByAgent
      ? UserMapper.toDomain((raw as any).resolvedByAgent)
      : undefined;

    let assignedAgentIdStr = null;
    if (raw.assignedAgentId) {
      assignedAgentIdStr =
        typeof raw.assignedAgentId === 'object' && '_id' in raw.assignedAgentId
          ? (raw.assignedAgentId as any)._id.toString()
          : raw.assignedAgentId.toString();
    }

    let claimedByIdStr = null;
    if (raw.claimedById) {
      claimedByIdStr =
        typeof raw.claimedById === 'object' && '_id' in raw.claimedById
          ? (raw.claimedById as any)._id.toString()
          : raw.claimedById.toString();
    }

    return {
      id: raw._id.toString(),
      tenantId: raw.tenantId?.toString(),
      channelId: raw.channelId?.toString(),
      channelType: raw.channelType as ChannelType,
      channelAccount: (raw as any).channelAccount,
      externalConversationId: raw.externalId,
      customer: raw.customer,
      assignedAgentId: assignedAgentIdStr,
      claimedBy: claimedByIdStr,
      claimedAt: raw.claimedAt,
      status: raw.status as any,
      lastMessage: raw.lastMessage,
      lastMessageAt: raw.lastMessageAt,
      unreadCount: raw.unreadCount,
      linkedContactId: undefined, // Add if needed
      linkedLeadId: undefined, // Add if needed
      tags: raw.tags || [],
      reopenCount: (raw as any).reopenCount ?? 0,
      previousConversationId: (raw as any).previousConversationId ?? null,
      resolvedByAgentId: (raw as any).resolvedByAgentId ?? null,
      resolvedAt: (raw as any).resolvedAt ?? null,
      resolveReason: (raw as any).resolveReason ?? null,
      resolveNote: (raw as any).resolveNote ?? null,
      resolveSource: (raw as any).resolveSource ?? null,
      assignedAgent: assignedAgentObj,
      resolvedByAgent: resolvedByAgentObj,
      createdAt: (raw as any).createdAt,
      updatedAt: (raw as any).updatedAt,
    };
  }

  static toPersistence(domain: OmniConversation): OmniConversationSchemaClass {
    const raw = new OmniConversationSchemaClass();
    if (domain.id) {
      raw._id = domain.id;
    }
    raw.tenantId = domain.tenantId;
    raw.channelId = domain.channelId;
    (raw as any).channelAccount = domain.channelAccount;
    raw.channelType = domain.channelType;
    raw.externalId = domain.externalConversationId;
    raw.customer = domain.customer;
    raw.assignedAgentId = domain.assignedAgentId;
    raw.claimedById = domain.claimedBy;
    raw.claimedAt = domain.claimedAt;
    raw.status = domain.status;
    raw.lastMessage = domain.lastMessage;
    raw.lastMessageAt = domain.lastMessageAt;
    raw.unreadCount = domain.unreadCount;
    raw.tags = domain.tags;
    (raw as any).reopenCount = domain.reopenCount;
    (raw as any).previousConversationId = domain.previousConversationId;
    (raw as any).resolvedByAgentId = domain.resolvedByAgentId;
    (raw as any).resolvedAt = domain.resolvedAt;
    (raw as any).resolveReason = domain.resolveReason;
    (raw as any).resolveNote = domain.resolveNote;
    (raw as any).resolveSource = domain.resolveSource;

    // Default system fields handled by mongoose logic generally
    return raw;
  }
}
