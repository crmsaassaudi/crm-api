import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, SortOrder, Types } from 'mongoose';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../infrastructure/persistence/document/entities/omni-conversation.schema';
import { OmniConversation } from '../domain/omni-conversation';
import { OmniConversationMapper } from '../infrastructure/persistence/document/mappers/omni-conversation.mapper';
import { PaginationResponseDto } from '../../utils/dto/pagination-response.dto';
import { pagination } from '../../utils/pagination';

export interface ConversationQuery {
  tenantId: string;
  status?: string | string[];
  channelType?: string;
  assignedAgent?: string;
  search?: string;
}

export interface ConversationTimelineCursor {
  createdAt: Date;
  id: string;
}

export interface ThreadSessionSlice {
  sessions: OmniConversation[];
  hasMore: boolean;
  cursor: ConversationTimelineCursor | null;
}

export interface ThreadIdentity {
  tenantId: string;
  channelType: string;
  channelAccount: string;
  externalId: string;
}

@Injectable()
export class ConversationRepository {
  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly model: Model<OmniConversationDocument>,
  ) {}

  async findById(id: string): Promise<OmniConversation | null> {
    const doc = await this.model
      .findById(id)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Find the ACTIVE (open or pending) conversation for a given external thread ID.
   * This is the key query for session management — if no active session exists,
   * the caller should create a new one.
   */
  async findActiveByExternalId(
    tenantId: string,
    channelType: string,
    channelAccount: string,
    externalId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOne({
        tenantId,
        channelType,
        channelAccount,
        externalId,
        status: { $in: ['open', 'pending'] },
      })
      .sort({ createdAt: -1 }) // latest active session
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  async create(
    data: Partial<OmniConversationSchemaClass>,
  ): Promise<OmniConversation> {
    const doc = await this.model.create(data);
    return OmniConversationMapper.toDomain(doc);
  }

  /**
   * Paginated list of conversations for a tenant, sorted by last activity.
   */
  async findPaginated(
    query: ConversationQuery,
    page: number,
    limit: number,
  ): Promise<PaginationResponseDto<OmniConversation>> {
    const filter: FilterQuery<OmniConversationDocument> = {
      tenantId: query.tenantId,
    };

    if (query.status) {
      filter.status = Array.isArray(query.status)
        ? { $in: query.status }
        : query.status;
    }
    if (query.channelType) {
      filter.channelType = query.channelType;
    }
    if (query.assignedAgent) {
      filter.assignedAgentId = query.assignedAgent;
    }
    if (query.search) {
      filter.$or = [
        { 'customer.name': { $regex: query.search, $options: 'i' } },
        { lastMessage: { $regex: query.search, $options: 'i' } },
      ];
    }

    const sort: Record<string, SortOrder> = { lastMessageAt: -1 };

    // Convert 1-indexed to 0-indexed for Mongoose skip
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * limit;

    const [items, total] = await Promise.all([
      this.model
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('assignedAgent')
        .populate('resolvedByAgent')
        .exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    const mappedItems = items.map((doc) =>
      OmniConversationMapper.toDomain(doc),
    );

    return pagination(mappedItems, total, { page: safePage, limit });
  }

  async updateStatus(
    id: string,
    status: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(id, { status }, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Update status with metadata — captures who resolved/closed and when.
   * Also invalidates identity cache by emitting an event.
   */
  async updateStatusWithMetadata(
    id: string,
    status: 'resolved' | 'closed',
    agentId: string | null,
    reason?: string,
    note?: string,
    resolveSource?: string,
  ): Promise<OmniConversation | null> {
    const update: Record<string, any> = { status };

    update.resolvedByAgentId = agentId;
    update.resolvedAt = new Date();
    update.resolveSource = resolveSource ?? 'agent';
    if (note) update.resolveNote = note;
    if (reason) {
      update.resolveReason = reason;
    }

    const doc = await this.model
      .findByIdAndUpdate(id, update, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Find the most recent conversation by external ID, regardless of status.
   * Used when creating a new session to link back to the previous one.
   */
  async findLastByExternalId(
    tenantId: string,
    channelType: string,
    channelAccount: string,
    externalId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOne({
        tenantId,
        channelType,
        channelAccount,
        externalId,
      })
      .sort({ createdAt: -1 })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  async updateLastMessage(
    id: string,
    lastMessage: string,
    lastMessageAt: Date,
  ): Promise<void> {
    await this.model
      .findByIdAndUpdate(id, {
        lastMessage,
        lastMessageAt,
        $inc: { messageCount: 1, unreadCount: 1 },
      })
      .exec();
  }

  /**
   * Update the timestamp of the customer's most recent inbound message.
   * Used to calculate the platform reply window (e.g. 24h for Facebook).
   */
  async updateLastCustomerMessageAt(id: string, date: Date): Promise<void> {
    await this.model
      .findByIdAndUpdate(id, { $set: { lastCustomerMessageAt: date } })
      .exec();
  }

  async addTag(id: string, tag: string): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(id, { $addToSet: { tags: tag } }, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  async claimConversation(
    id: string,
    agentId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(
        id,
        {
          claimedById: agentId,
          claimedAt: new Date(),
          assignedAgentId: agentId,
        },
        { new: true },
      )
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  async resetUnreadCount(id: string): Promise<void> {
    await this.model.findByIdAndUpdate(id, { unreadCount: 0 }).exec();
  }

  /**
   * Update the assigned agent for a conversation.
   */
  async updateAssignment(
    id: string,
    agentId: string | null,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(id, { assignedAgentId: agentId }, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Update the cached customer profile (name, avatarUrl) fetched from the platform.
   * Used after creating a new conversation to enrich the display information.
   */
  async updateCustomerProfile(
    id: string,
    profile: { name?: string; avatarUrl?: string },
  ): Promise<void> {
    const update: Record<string, any> = {};
    if (profile.name) update['customer.name'] = profile.name;
    if (profile.avatarUrl) update['customer.avatarUrl'] = profile.avatarUrl;
    if (Object.keys(update).length === 0) return;
    await this.model.findByIdAndUpdate(id, { $set: update }).exec();
  }

  async updateContactId(id: string, contactId: string): Promise<void> {
    await this.model.findByIdAndUpdate(id, { $set: { contactId } }).exec();
  }

  /**
   * Find ALL conversations for a given customer thread (any status), sorted oldest-first.
   * Used for cross-conversation message history.
   */
  async findAllByExternalId(
    tenantId: string,
    channelType: string,
    channelAccount: string,
    externalId: string,
  ): Promise<OmniConversation[]> {
    const docs = await this.model
      .find({ tenantId, channelType, channelAccount, externalId })
      .sort({ createdAt: 1 })
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .exec();
    return docs.map((doc) => OmniConversationMapper.toDomain(doc));
  }

  async findThreadSessionsAroundAnchor(params: {
    thread: ThreadIdentity;
    anchor: ConversationTimelineCursor;
    pastLimit: number;
    futureLimit: number;
  }): Promise<{ past: ThreadSessionSlice; future: ThreadSessionSlice }> {
    const [past, future] = await Promise.all([
      this.findPastSessionsByCursor({
        ...params.thread,
        cursor: params.anchor,
        limit: params.pastLimit,
      }),
      this.findFutureSessionsByCursor({
        ...params.thread,
        cursor: params.anchor,
        limit: params.futureLimit,
      }),
    ]);

    return { past, future };
  }

  async findPastSessionsByCursor(params: {
    tenantId: string;
    channelType: string;
    channelAccount: string;
    externalId: string;
    cursor: ConversationTimelineCursor;
    limit: number;
  }): Promise<ThreadSessionSlice> {
    const safeLimit = Math.max(1, Math.min(params.limit, 50));
    const filter = {
      tenantId: params.tenantId,
      channelType: params.channelType,
      channelAccount: params.channelAccount,
      externalId: params.externalId,
      ...this.buildDirectionalCursorFilter('past', params.cursor),
    };

    const docs = await this.model
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(safeLimit + 1)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .exec();

    const hasMore = docs.length > safeLimit;
    const trimmed = hasMore ? docs.slice(0, safeLimit) : docs;
    const ordered = trimmed.reverse();
    const sessions = ordered.map((doc) => OmniConversationMapper.toDomain(doc));
    const oldest = sessions[0] ?? null;

    return {
      sessions,
      hasMore,
      cursor: oldest
        ? {
            createdAt: oldest.createdAt,
            id: oldest.id,
          }
        : null,
    };
  }

  async findFutureSessionsByCursor(params: {
    tenantId: string;
    channelType: string;
    channelAccount: string;
    externalId: string;
    cursor: ConversationTimelineCursor;
    limit: number;
  }): Promise<ThreadSessionSlice> {
    const safeLimit = Math.max(1, Math.min(params.limit, 50));
    const filter = {
      tenantId: params.tenantId,
      channelType: params.channelType,
      channelAccount: params.channelAccount,
      externalId: params.externalId,
      ...this.buildDirectionalCursorFilter('future', params.cursor),
    };

    const docs = await this.model
      .find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(safeLimit + 1)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .exec();

    const hasMore = docs.length > safeLimit;
    const trimmed = hasMore ? docs.slice(0, safeLimit) : docs;
    const sessions = trimmed.map((doc) => OmniConversationMapper.toDomain(doc));
    const newest = sessions[sessions.length - 1] ?? null;

    return {
      sessions,
      hasMore,
      cursor: newest
        ? {
            createdAt: newest.createdAt,
            id: newest.id,
          }
        : null,
    };
  }

  /**
   * Count open/pending conversations assigned to a specific agent.
   * Used by the least-busy assignment strategy.
   */
  async countOpenByAgent(tenantId: string, agentId: string): Promise<number> {
    if (!Types.ObjectId.isValid(agentId)) return 0;
    return this.model
      .countDocuments({
        tenantId,
        assignedAgentId: agentId,
        status: { $in: ['open', 'pending'] },
      })
      .exec();
  }

  /**
   * Reopen a resolved/closed conversation: set status back to 'open',
   * increment reopenCount, and clear resolve metadata.
   */
  async reopenConversation(
    conversationId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(
        conversationId,
        {
          $set: {
            status: 'open',
            resolvedByAgentId: null,
            resolvedAt: null,
            resolveReason: null,
            resolveNote: null,
            resolveSource: null,
          },
          $inc: { reopenCount: 1 },
        },
        { new: true },
      )
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Find the most recently resolved/closed conversation for a contact.
   * Used by sticky routing to find the agent who last handled this customer.
   */
  async findLastResolvedByContact(
    tenantId: string,
    contactId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOne({
        tenantId,
        contactId,
        status: { $in: ['resolved', 'closed'] },
        assignedAgentId: { $ne: null },
      })
      .sort({ resolvedAt: -1, updatedAt: -1 })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Find the most recently resolved/closed conversation for an external sender.
   * Fallback for sticky routing when contactId is not available.
   */
  async findLastResolvedBySender(
    tenantId: string,
    externalSenderId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOne({
        tenantId,
        'customer.externalId': externalSenderId,
        status: { $in: ['resolved', 'closed'] },
        assignedAgentId: { $ne: null },
      })
      .sort({ resolvedAt: -1, updatedAt: -1 })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Find all open/pending conversations assigned to a specific agent.
   * Used by AgentFallbackService to reassign conversations when an agent goes offline.
   */
  async findOpenByAgent(
    tenantId: string,
    agentId: string,
  ): Promise<OmniConversation[]> {
    if (!Types.ObjectId.isValid(agentId)) return [];
    const docs = await this.model
      .find({
        tenantId,
        assignedAgentId: agentId,
        status: { $in: ['open', 'pending'] },
      })
      .sort({ lastMessageAt: -1 })
      .exec();
    return docs.map((doc) => OmniConversationMapper.toDomain(doc));
  }

  private buildDirectionalCursorFilter(
    direction: 'past' | 'future',
    cursor: ConversationTimelineCursor,
  ): FilterQuery<OmniConversationDocument> {
    const cursorId = Types.ObjectId.isValid(cursor.id)
      ? new Types.ObjectId(cursor.id)
      : null;

    if (!cursorId) {
      return {
        createdAt:
          direction === 'past'
            ? { $lt: cursor.createdAt }
            : { $gt: cursor.createdAt },
      };
    }

    if (direction === 'past') {
      return {
        $or: [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: cursorId } },
        ],
      };
    }

    return {
      $or: [
        { createdAt: { $gt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $gt: cursorId } },
      ],
    };
  }

  /**
   * Get all distinct tenant IDs that have at least one open or pending conversation.
   * Used by the auto-resolve cron to know which tenants to scan.
   */
  async findDistinctTenantIdsWithActiveConversations(): Promise<string[]> {
    const tenantIds = await this.model.distinct('tenantId', {
      status: { $in: ['open', 'pending'] },
    });
    return tenantIds.map((id) => id.toString());
  }

  /**
   * Find open/pending conversations where lastMessageAt is older than the cutoff date.
   * Used by auto-resolve to identify conversations that should be auto-resolved.
   */
  async findIdleConversations(
    tenantId: string,
    lastMessageBefore: Date,
  ): Promise<OmniConversation[]> {
    const docs = await this.model
      .find({
        tenantId,
        status: { $in: ['open', 'pending'] },
        $or: [
          { lastMessageAt: { $lte: lastMessageBefore } },
          { lastMessageAt: null, createdAt: { $lte: lastMessageBefore } },
        ],
      })
      .limit(100) // Process in batches to avoid memory issues
      .exec();
    return docs.map(OmniConversationMapper.toDomain);
  }
}
