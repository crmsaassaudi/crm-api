import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, SortOrder } from 'mongoose';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../infrastructure/persistence/document/entities/omni-conversation.schema';

export interface ConversationQuery {
  tenant: string;
  status?: string | string[];
  channelType?: string;
  assignedAgent?: string;
  search?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

@Injectable()
export class ConversationRepository {
  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly model: Model<OmniConversationDocument>,
  ) {}

  async findById(id: string): Promise<OmniConversationDocument | null> {
    return this.model.findById(id).exec();
  }

  /**
   * Find the ACTIVE (open or pending) conversation for a given external thread ID.
   * This is the key query for session management — if no active session exists,
   * the caller should create a new one.
   */
  async findActiveByExternalId(
    tenant: string,
    channel: string,
    externalId: string,
  ): Promise<OmniConversationDocument | null> {
    return this.model
      .findOne({
        tenant,
        channel,
        externalId,
        status: { $in: ['open', 'pending'] },
      })
      .sort({ createdAt: -1 }) // latest active session
      .exec();
  }

  async create(
    data: Partial<OmniConversationSchemaClass>,
  ): Promise<OmniConversationDocument> {
    return this.model.create(data);
  }

  /**
   * Paginated list of conversations for a tenant, sorted by last activity.
   */
  async findPaginated(
    query: ConversationQuery,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<OmniConversationDocument>> {
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

    const [items, total] = await Promise.all([
      this.model
        .find(filter)
        .sort(sort)
        .skip(page * limit)
        .limit(limit)
        .exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return {
      items,
      total,
      page,
      limit,
      hasMore: (page + 1) * limit < total,
    };
  }

  async updateStatus(id: string, status: string): Promise<OmniConversationDocument | null> {
    return this.model
      .findByIdAndUpdate(id, { status }, { new: true })
      .exec();
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

  async addTag(id: string, tag: string): Promise<OmniConversationDocument | null> {
    return this.model
      .findByIdAndUpdate(
        id,
        { $addToSet: { tags: tag } },
        { new: true },
      )
      .exec();
  }

  async claimConversation(
    id: string,
    agentId: string,
  ): Promise<OmniConversationDocument | null> {
    return this.model
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
  }

  async resetUnreadCount(id: string): Promise<void> {
    await this.model.findByIdAndUpdate(id, { unreadCount: 0 }).exec();
  }
}
