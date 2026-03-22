import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, SortOrder } from 'mongoose';
import {
  OmniMessageSchemaClass,
  OmniMessageDocument,
} from '../infrastructure/persistence/document/entities/omni-message.schema';
import { OmniMessage } from '../domain/omni-message';
import { OmniMessageMapper } from '../infrastructure/persistence/document/mappers/omni-message.mapper';
import { PaginationResponseDto } from '../../utils/dto/pagination-response.dto';
import { pagination } from '../../utils/pagination';

@Injectable()
export class MessageRepository {
  constructor(
    @InjectModel(OmniMessageSchemaClass.name)
    private readonly model: Model<OmniMessageDocument>,
  ) {}

  async create(
    data: Partial<OmniMessageSchemaClass>,
  ): Promise<OmniMessage> {
    const doc = await this.model.create(data);
    return OmniMessageMapper.toDomain(doc);
  }

  /**
   * Get messages for a conversation, paginated, most recent first (for chat scroll).
   */
  async findByConversation(
    conversationId: string,
    page: number,
    limit: number,
  ): Promise<PaginationResponseDto<OmniMessage>> {
    const filter = { conversation: conversationId };
    const sort: Record<string, SortOrder> = { createdAt: -1 };

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

    // Reverse so oldest first for display
    const reversed = items.reverse();
    const mappedItems = reversed.map(doc => OmniMessageMapper.toDomain(doc));

    return pagination(mappedItems, total, { page: safePage, limit });
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

  async updateStatus(id: string, status: string, externalId?: string): Promise<void> {
    const update: any = { status };
    if (externalId) {
      update.externalMessageId = externalId;
    }
    await this.model.findByIdAndUpdate(id, { $set: update }).exec();
  }
}
