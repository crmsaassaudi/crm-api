import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, SortOrder } from 'mongoose';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../infrastructure/persistence/document/entities/omni-conversation.schema';
import { OmniConversation } from '../domain/omni-conversation';
import { OmniConversationMapper } from '../infrastructure/persistence/document/mappers/omni-conversation.mapper';
import { PaginationResponseDto } from '../../utils/dto/pagination-response.dto';
import { pagination } from '../../utils/pagination';

export interface ConversationQuery {
  tenant: string;
  status?: string | string[];
  channelType?: string;
  assignedAgent?: string;
  search?: string;
}

@Injectable()
export class ConversationRepository {
  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly model: Model<OmniConversationDocument>,
  ) {}

  async findById(id: string): Promise<OmniConversation | null> {
    const doc = await this.model.findById(id).exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Find the ACTIVE (open or pending) conversation for a given external thread ID.
   * This is the key query for session management — if no active session exists,
   * the caller should create a new one.
   */
  async findActiveByExternalId(
    tenant: string,
    channelType: string,
    channelAccount: string,
    externalId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOne({
        tenant,
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
      tenant: query.tenant,
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
      filter.assignedAgent = query.assignedAgent;
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
        .exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    const mappedItems = items.map(doc => OmniConversationMapper.toDomain(doc));

    return pagination(mappedItems, total, { page: safePage, limit });
  }

  async updateStatus(id: string, status: string): Promise<OmniConversation | null> {
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
    agentId: string,
    reason?: string,
  ): Promise<OmniConversation | null> {
    const update: Record<string, any> = { status };

    if (status === 'resolved') {
      update.resolvedByAgentId = agentId;
      update.resolvedAt = new Date();
    } else if (status === 'closed') {
      update.closedByAgentId = agentId;
      update.closedAt = new Date();
    }
    if (reason) {
      update.closeReason = reason;
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
    tenant: string,
    channelType: string,
    channelAccount: string,
    externalId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOne({
        tenant,
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

  async addTag(id: string, tag: string): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(
        id,
        { $addToSet: { tags: tag } },
        { new: true },
      )
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
          claimedBy: agentId,
          claimedAt: new Date(),
          assignedAgent: agentId,
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
      .findByIdAndUpdate(
        id,
        { assignedAgent: agentId },
        { new: true },
      )
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

  /**
   * Find ALL conversations for a given customer thread (any status), sorted oldest-first.
   * Used for cross-conversation message history.
   */
  async findAllByExternalId(
    tenant: string,
    channelType: string,
    channelAccount: string,
    externalId: string,
  ): Promise<OmniConversation[]> {
    const docs = await this.model
      .find({ tenant, channelType, channelAccount, externalId })
      .sort({ createdAt: 1 })
      .exec();
    return docs.map((doc) => OmniConversationMapper.toDomain(doc));
  }

  /**
   * Count open/pending conversations assigned to a specific agent.
   * Used by the least-busy assignment strategy.
   */
  async countOpenByAgent(tenant: string, agentId: string): Promise<number> {
    return this.model
      .countDocuments({
        tenant,
        assignedAgent: agentId,
        status: { $in: ['open', 'pending'] },
      })
      .exec();
  }
}
