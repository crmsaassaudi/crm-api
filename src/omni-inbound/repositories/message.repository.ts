import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, SortOrder } from 'mongoose';
import {
  OmniMessageSchemaClass,
  OmniMessageDocument,
} from '../infrastructure/persistence/document/entities/omni-message.schema';
import { PaginatedResult } from './conversation.repository';

@Injectable()
export class MessageRepository {
  constructor(
    @InjectModel(OmniMessageSchemaClass.name)
    private readonly model: Model<OmniMessageDocument>,
  ) {}

  async create(
    data: Partial<OmniMessageSchemaClass>,
  ): Promise<OmniMessageDocument> {
    return this.model.create(data);
  }

  /**
   * Get messages for a conversation, paginated, most recent first (for chat scroll).
   */
  async findByConversation(
    conversationId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<OmniMessageDocument>> {
    const filter = { conversation: conversationId };
    const sort: Record<string, SortOrder> = { createdAt: -1 };

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
      items: items.reverse(), // reverse so oldest first for display
      total,
      page,
      limit,
      hasMore: (page + 1) * limit < total,
    };
  }

  /**
   * Check if a message with a given external ID already exists (deduplication).
   */
  async existsByExternalId(
    tenant: string,
    externalMessageId: string,
  ): Promise<boolean> {
    const doc = await this.model
      .findOne({ tenant, externalMessageId })
      .select('_id')
      .lean()
      .exec();
    return !!doc;
  }

  async updateStatus(id: string, status: string): Promise<void> {
    await this.model.findByIdAndUpdate(id, { status }).exec();
  }
}
