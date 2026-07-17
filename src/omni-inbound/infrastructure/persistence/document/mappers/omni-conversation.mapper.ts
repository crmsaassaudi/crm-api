import { OmniConversation } from '../../../../domain/omni-conversation';
import { OmniConversationSchemaClass } from '../entities/omni-conversation.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class OmniConversationMapper {
  static toDomain(raw: OmniConversationSchemaClass): OmniConversation {
    const assignedAgentObj = (raw as any).assignedAgent
      ? UserMapper.toDomain((raw as any).assignedAgent)
      : undefined;
    const resolvedByAgentObj = (raw as any).resolvedByAgent
      ? UserMapper.toDomain((raw as any).resolvedByAgent)
      : undefined;

    return {
      id: raw._id.toString(),
      tenantId: raw.tenantId?.toString(),
      channelId: raw.channelId?.toString(),
      channelType: raw.channelType,
      channelAccount: (raw as any).channelAccount,
      externalConversationId: raw.externalId,
      contactId: this.normalizeId((raw as any).contactId),
      customer: raw.customer,
      assignedAgentId: this.normalizeId(raw.assignedAgentId),
      assignedGroupId: raw.assignedGroupId?.toString() ?? null,
      claimedBy: this.normalizeId(raw.claimedById),
      claimedAt: raw.claimedAt,
      status: raw.status as any,
      bot: this.mapBotSettings((raw as any).bot),
      lastMessage: raw.lastMessage,
      lastMessageAt: raw.lastMessageAt,
      unreadCount: raw.unreadCount,
      linkedLeadId: undefined,
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
      lastCustomerMessageAt: (raw as any).lastCustomerMessageAt ?? null,
      frtDeadline: (raw as any).frtDeadline ?? null,
      frtBreached: (raw as any).frtBreached ?? false,
      resolutionDeadline: (raw as any).resolutionDeadline ?? null,
      resolutionBreached: (raw as any).resolutionBreached ?? false,
      escalationLevel: (raw as any).escalationLevel ?? null,
      snoozeUntil: (raw as any).snoozeUntil ?? null,
      createdAt: (raw as any).createdAt,
      updatedAt: (raw as any).updatedAt,
    };
  }

  private static normalizeId(id: any): string | null {
    if (!id) return null;
    return typeof id === 'object' && '_id' in id
      ? id._id.toString()
      : id.toString();
  }

  private static mapBotSettings(bot: any) {
    if (!bot) return null;
    return {
      enabled: Boolean(bot.enabled),
      provider: bot.provider ?? 'typebot',
      flowId: bot.flowId ?? null,
      sessionId: bot.sessionId ?? null,
      status: bot.status ?? 'active',
      lastError: bot.lastError ?? null,
      lockedAt: bot.lockedAt ?? null,
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
    (raw as any).contactId = domain.contactId;
    raw.customer = domain.customer;
    raw.assignedAgentId = domain.assignedAgentId;
    (raw as any).assignedGroupId = domain.assignedGroupId;
    raw.claimedById = domain.claimedBy;
    raw.claimedAt = domain.claimedAt;
    raw.status = domain.status;
    (raw as any).bot = domain.bot ?? undefined;
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
    (raw as any).lastCustomerMessageAt = domain.lastCustomerMessageAt;

    // Default system fields handled by mongoose logic generally
    return raw;
  }
}
