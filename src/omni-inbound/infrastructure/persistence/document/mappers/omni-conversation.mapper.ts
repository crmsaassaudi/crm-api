import { OmniConversation } from '../../../../domain/omni-conversation';
import { OmniConversationSchemaClass } from '../entities/omni-conversation.schema';
import { ChannelType } from '../../../../domain/omni-payload';

export class OmniConversationMapper {
  static toDomain(raw: OmniConversationSchemaClass): OmniConversation {
    let assignedAgentIdStr = null;
    if (raw.assignedAgent) {
      assignedAgentIdStr =
        typeof raw.assignedAgent === 'object' && '_id' in raw.assignedAgent
          ? (raw.assignedAgent as any)._id.toString()
          : raw.assignedAgent.toString();
    }

    let claimedByIdStr = null;
    if (raw.claimedBy) {
      claimedByIdStr =
        typeof raw.claimedBy === 'object' && '_id' in raw.claimedBy
          ? (raw.claimedBy as any)._id.toString()
          : raw.claimedBy.toString();
    }

    return {
      id: raw._id.toString(),
      tenantId: raw.tenant?.toString(),
      channelId: raw.channel?.toString(),
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
      linkedLeadId: undefined,    // Add if needed
      tags: raw.tags || [],
      reopenCount: (raw as any).reopenCount ?? 0,
      previousConversationId: (raw as any).previousConversationId ?? null,
      resolvedByAgentId: (raw as any).resolvedByAgentId ?? null,
      resolvedAt: (raw as any).resolvedAt ?? null,
      closedByAgentId: (raw as any).closedByAgentId ?? null,
      closedAt: (raw as any).closedAt ?? null,
      closeReason: (raw as any).closeReason ?? null,
      resolveNote: (raw as any).resolveNote ?? null,
      resolveSource: (raw as any).resolveSource ?? null,
      createdAt: (raw as any).createdAt,
      updatedAt: (raw as any).updatedAt,
    };
  }

  static toPersistence(domain: OmniConversation): OmniConversationSchemaClass {
    const raw = new OmniConversationSchemaClass();
    if (domain.id) {
      raw._id = domain.id;
    }
    raw.tenant = domain.tenantId;
    raw.channel = domain.channelId;
    (raw as any).channelAccount = domain.channelAccount;
    raw.channelType = domain.channelType;
    raw.externalId = domain.externalConversationId;
    raw.customer = domain.customer;
    raw.assignedAgent = domain.assignedAgentId;
    raw.claimedBy = domain.claimedBy;
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
    (raw as any).closedByAgentId = domain.closedByAgentId;
    (raw as any).closedAt = domain.closedAt;
    (raw as any).closeReason = domain.closeReason;
    (raw as any).resolveNote = domain.resolveNote;
    (raw as any).resolveSource = domain.resolveSource;
    
    // Default system fields handled by mongoose logic generally
    return raw;
  }
}
