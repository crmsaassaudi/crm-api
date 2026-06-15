import { Injectable, Logger } from '@nestjs/common';
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
import { cappedCount } from '../../utils/capped-count';

export interface ConversationQuery {
  tenantId: string;
  status?: string | string[];
  channels?: string[];
  assignedAgent?: string | null;
  assignedGroup?: string | null;
  unassigned?: boolean;
  sla?: string[];
  tags?: string[];
  isVip?: boolean;
  hasUnread?: boolean;
  search?: string;
  cursor?: string;
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
  private readonly logger = new Logger(ConversationRepository.name);

  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly model: Model<OmniConversationDocument>,
  ) {}

  async findById(id: string): Promise<OmniConversation | null> {
    const doc = await this.model
      .findById(id)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .lean()
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc as any) : null;
  }

  async findByIds(
    tenantId: string,
    ids: string[],
  ): Promise<OmniConversation[]> {
    const safeIds = Array.from(new Set(ids)).filter((id) =>
      Types.ObjectId.isValid(id),
    );
    if (safeIds.length === 0) return [];

    const docs = await this.model
      .find({ _id: { $in: safeIds }, tenantId })
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .lean()
      .exec();

    return docs.map((doc) => OmniConversationMapper.toDomain(doc as any));
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
      .lean()
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc as any) : null;
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
    const filter = this.buildFilter(query);
    const sort: Record<string, SortOrder> = { lastMessageAt: -1 };

    // Convert 1-indexed to 0-indexed for Mongoose skip
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * limit;

    const [items, { totalItems: total }] = await Promise.all([
      this.model
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('assignedAgent')
        .populate('resolvedByAgent')
        .lean()
        .exec(),
      cappedCount(this.model as Model<any>, filter),
    ]);

    const mappedItems = items.map((doc) =>
      OmniConversationMapper.toDomain(doc as any),
    );

    return pagination(mappedItems, total, { page: safePage, limit });
  }

  async findCursorPaginated(query: ConversationQuery, limit: number) {
    const filter = this.buildFilter(query);

    if (query.cursor) {
      filter.lastMessageAt = { $lt: new Date(query.cursor) };
    }

    const safeLimit = Math.max(1, Math.min(limit, 50));

    // Fetch limit + 1 to check if there are more items
    const items = await this.model
      .find(filter)
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(safeLimit + 1)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .lean()
      .exec();

    const hasNextPage = items.length > safeLimit;
    const pageItems = hasNextPage ? items.slice(0, safeLimit) : items;

    const mappedItems = pageItems.map((doc) =>
      OmniConversationMapper.toDomain(doc as any),
    );

    const nextCursor =
      pageItems.length > 0 && pageItems[pageItems.length - 1].lastMessageAt
        ? pageItems[pageItems.length - 1].lastMessageAt?.toISOString() || null
        : null;

    return {
      data: mappedItems,
      nextCursor,
      hasNextPage,
      totalItems: undefined,
    };
  }

  private buildFilter(
    query: ConversationQuery,
  ): FilterQuery<OmniConversationDocument> {
    const filter: FilterQuery<OmniConversationDocument> = {
      tenantId: query.tenantId,
    };

    if (query.status) {
      filter.status = Array.isArray(query.status)
        ? { $in: query.status }
        : query.status;
    }
    if (query.channels && query.channels.length > 0) {
      filter.channelType = { $in: query.channels };
    }
    if (query.unassigned) {
      filter.assignedAgentId = null;
      filter.assignedGroupId = null;
    } else {
      if (query.assignedAgent !== undefined) {
        filter.assignedAgentId = query.assignedAgent;
      }
      if (query.assignedGroup !== undefined) {
        filter.assignedGroupId = query.assignedGroup;
      }
    }

    if (query.sla && query.sla.length > 0) {
      // Logic for sla: 'warning' or 'breached'
      // Assuming we map 'warning' to some criteria and 'breached' to frtBreached / resolutionBreached
      const slaOrConditions: any[] = [];
      if (query.sla.includes('breached')) {
        slaOrConditions.push({ frtBreached: true });
        slaOrConditions.push({ resolutionBreached: true });
      }
      if (query.sla.includes('warning')) {
        // Find documents where deadline is soon (e.g. within 15 minutes) but not breached
        const warningTime = new Date(Date.now() + 15 * 60000);
        slaOrConditions.push({
          frtBreached: false,
          frtDeadline: { $lte: warningTime },
        });
        slaOrConditions.push({
          resolutionBreached: false,
          resolutionDeadline: { $lte: warningTime },
        });
      }
      if (slaOrConditions.length > 0) {
        filter.$or = slaOrConditions;
      }
    }

    if (query.tags && query.tags.length > 0) {
      filter.tags = { $in: query.tags };
    }

    if (query.isVip !== undefined) {
      filter.isVip = query.isVip;
    }

    if (query.hasUnread !== undefined) {
      filter.unreadCount = query.hasUnread ? { $gt: 0 } : 0;
    }

    if (query.search) {
      filter.$text = { $search: query.search };
    }

    return filter;
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

  async updateBotState(
    id: string,
    fields: Partial<{
      enabled: boolean;
      provider: string;
      flowId: string | null;
      sessionId: string | null;
      status: 'active' | 'handoff' | 'ended';
      lastError: string | null;
      lockedAt: Date | null;
    }>,
  ): Promise<OmniConversation | null> {
    const $set: Record<string, any> = {};
    const $unset: Record<string, 1> = {};

    for (const [key, value] of Object.entries(fields)) {
      const path = `bot.${key}`;
      if (value === null) {
        $unset[path] = 1;
      } else if (value !== undefined) {
        $set[path] = value;
      }
    }

    const update: Record<string, any> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;
    if (Object.keys(update).length === 0) return this.findById(id);

    const doc = await this.model
      .findByIdAndUpdate(id, update, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  async markBotHandoff(id: string): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(
        id,
        {
          $set: {
            'bot.enabled': false,
            'bot.status': 'handoff',
          },
          $unset: {
            'bot.lockedAt': 1,
          },
        },
        { new: true },
      )
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
      .lean()
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc as any) : null;
  }

  async updateLastMessage(
    id: string,
    lastMessage: string,
    lastMessageAt: Date,
    senderType?: string,
  ): Promise<void> {
    const update: Record<string, any> = {
      lastMessage,
      lastMessageAt,
      $inc: { messageCount: 1 },
    };

    // Only increment unread count for customer messages — agent/system
    // messages should not trigger the unread badge.
    if (!senderType || senderType === 'customer') {
      update.$inc.unreadCount = 1;
    }

    await this.model.findByIdAndUpdate(id, update).exec();
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

  async removeTag(id: string, tag: string): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(id, { $pull: { tags: tag } }, { new: true })
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
   * Optimistic assignment used by the auto-assignment hot path.
   * It only succeeds when the conversation is still active and unassigned.
   */
  async assignIfUnassigned(
    id: string,
    agentId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: id,
          status: { $in: ['open', 'pending'] },
          $or: [
            { assignedAgentId: null },
            { assignedAgentId: { $exists: false } },
          ],
        },
        { $set: { assignedAgentId: agentId } },
        { new: true },
      )
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Update the assigned group for a conversation.
   */
  async updateGroupAssignment(
    id: string,
    groupId: string | null,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(id, { assignedGroupId: groupId }, { new: true })
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

  async updateCustomerInfo(
    id: string,
    info: { email?: string; phone?: string; name?: string },
  ): Promise<OmniConversation | null> {
    const update: Record<string, any> = {};
    if (info.email !== undefined) update['customer.email'] = info.email;
    if (info.phone !== undefined) update['customer.phone'] = info.phone;
    if (info.name !== undefined) update['customer.name'] = info.name;

    if (Object.keys(update).length === 0) return null;

    const doc = await this.model
      .findByIdAndUpdate(id, { $set: update }, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
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
    limit = 100,
  ): Promise<OmniConversation[]> {
    const docs = await this.model
      .find({ tenantId, channelType, channelAccount, externalId })
      .sort({ createdAt: 1 })
      .limit(limit + 1)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .lean()
      .exec();

    if (docs.length > limit) {
      this.logger.warn(
        `findAllByExternalId truncated: ${docs.length} sessions for ` +
          `${channelType}/${externalId} (limit=${limit})`,
      );
      docs.length = limit; // truncate in-place
    }

    return docs.map((doc) => OmniConversationMapper.toDomain(doc as any));
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
   * Batch-count open/pending conversations for multiple agents in a single
   * aggregation pipeline. Eliminates N+1 queries in assignment strategies.
   *
   * Returns a Map<agentId, count>. Agents with zero open conversations
   * will NOT appear in the map — callers should default to 0.
   */
  async countOpenByAgents(
    tenantId: string,
    agentIds: string[],
  ): Promise<Map<string, number>> {
    const validIds = agentIds.filter((id) => Types.ObjectId.isValid(id));
    if (validIds.length === 0) return new Map();

    const results = await this.model.aggregate<{
      _id: string;
      count: number;
    }>([
      {
        $match: {
          tenantId: new Types.ObjectId(tenantId),
          assignedAgentId: {
            $in: validIds.map((id) => new Types.ObjectId(id)),
          },
          status: { $in: ['open', 'pending'] },
        },
      },
      {
        $group: {
          _id: '$assignedAgentId',
          count: { $sum: 1 },
        },
      },
    ]);

    const map = new Map<string, number>();
    for (const row of results) {
      map.set(row._id.toString(), row.count);
    }
    return map;
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
      .lean()
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc as any) : null;
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
      .lean()
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc as any) : null;
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
      .lean()
      .exec();
    return docs.map((doc) => OmniConversationMapper.toDomain(doc as any));
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
   * Patch SLA deadline / breach fields on a conversation document.
   * Used by SlaTriggerListener after scheduling BullMQ breach-check jobs.
   */
  async updateSlaFields(
    conversationId: string,
    fields: Partial<{
      frtPolicyId: string | null;
      frtDeadline: Date | null;
      frtBreached: boolean;
      resolutionPolicyId: string | null;
      resolutionDeadline: Date | null;
      resolutionBreached: boolean;
    }>,
  ): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    await this.model
      .updateOne({ _id: conversationId }, { $set: fields })
      .exec();
  }

  /**
   * Fetch an active (open/pending), unbreached conversation by ID for SLA processing.
   * Returns the raw lean document so the breach processor can read inline fields
   * (channelType, assignedAgentId, frtDeadline, resolutionDeadline) without mapping.
   *
   * @param conversationId  - MongoDB ObjectId string of the conversation
   * @param tenantId        - tenant owning the conversation (security check)
   * @param breachedField   - 'frtBreached' | 'resolutionBreached' — must still be false
   */
  async findByIdForSla(
    conversationId: string,
    tenantId: string,
    breachedField: 'frtBreached' | 'resolutionBreached',
  ): Promise<Record<string, any> | null> {
    return this.model
      .findOne({
        _id: conversationId,
        tenantId,
        status: { $in: ['open', 'pending'] },
        [breachedField]: false,
      })
      .lean()
      .exec();
  }

  /**
   * Atomically mark a conversation's SLA as breached.
   * Runs in a BullMQ worker with tenant CLS seeded from the job payload.
   */
  async markSlaBreached(
    conversationId: string,
    breachedField: 'frtBreached' | 'resolutionBreached',
  ): Promise<void> {
    await this.model
      .updateOne({ _id: conversationId }, { $set: { [breachedField]: true } })
      .exec();
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

  /**
   * Find all conversations linked to a specific CRM contact.
   * Used by Contact Detail → "Conversations" tab to show omni history.
   */
  async findByContactId(
    tenantId: string,
    contactId: string,
    page: number,
    limit: number,
  ): Promise<PaginationResponseDto<OmniConversation>> {
    const filter: FilterQuery<OmniConversationDocument> = {
      tenantId,
      contactId,
    };
    const sort: Record<string, SortOrder> = { lastMessageAt: -1 };

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const skip = (safePage - 1) * safeLimit;

    const [items, { totalItems: total }] = await Promise.all([
      this.model
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(safeLimit)
        .populate('assignedAgent')
        .populate('resolvedByAgent')
        .lean()
        .exec(),
      cappedCount(this.model as Model<any>, filter),
    ]);

    const mappedItems = items.map((doc) =>
      OmniConversationMapper.toDomain(doc as any),
    );

    return pagination(mappedItems, total, { page: safePage, limit: safeLimit });
  }
}
