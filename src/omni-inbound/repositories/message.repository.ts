import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, SortOrder, Types } from 'mongoose';
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

  async create(data: Partial<OmniMessageSchemaClass>): Promise<OmniMessage> {
    const doc = await this.model.create(data);
    return OmniMessageMapper.toDomain(doc);
  }

  async upsertInboundByExternalId(
    data: Partial<OmniMessageSchemaClass> & {
      tenantId: string;
      externalMessageId: string;
    },
  ): Promise<{ message: OmniMessage; inserted: boolean }> {
    const result = await this.model
      .updateOne(
        {
          tenantId: data.tenantId,
          externalMessageId: data.externalMessageId,
        },
        { $setOnInsert: data },
        { upsert: true },
      )
      .exec();

    const doc = await this.model
      .findOne({
        tenantId: data.tenantId,
        externalMessageId: data.externalMessageId,
      })
      .exec();

    if (!doc) {
      throw new Error(
        `Failed to read upserted inbound message ${data.externalMessageId}`,
      );
    }

    return {
      message: OmniMessageMapper.toDomain(doc),
      inserted: result.upsertedCount > 0,
    };
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<OmniMessage | null> {
    const doc = await this.model.findOne({ tenantId, idempotencyKey }).exec();
    return doc ? OmniMessageMapper.toDomain(doc) : null;
  }

  async findByExternalId(
    tenantId: string,
    externalMessageId: string,
  ): Promise<OmniMessage | null> {
    const doc = await this.model
      .findOne({ tenantId, externalMessageId })
      .exec();
    return doc ? OmniMessageMapper.toDomain(doc) : null;
  }

  /**
   * Get messages for a conversation, paginated, most recent first (for chat scroll).
   */
  async findByConversation(
    conversationId: string,
    page: number,
    limit: number,
  ): Promise<PaginationResponseDto<OmniMessage>> {
    const filter = { conversationId };
    const sort: Record<string, SortOrder> = { createdAt: -1 };

    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * limit;

    const [items, total] = await Promise.all([
      this.model.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    // Reverse so oldest first for display
    const reversed = [...items].reverse();
    const mappedItems = reversed.map((doc) =>
      OmniMessageMapper.toDomain(doc as any),
    );

    return pagination(mappedItems, total, { page: safePage, limit });
  }

  /**
   * PERF FIX #7: Fetch recent messages WITHOUT running countDocuments.
   * Used by the widget history endpoint which doesn't need pagination metadata.
   * Saves ~5-15ms per call by eliminating the count query.
   */
  async findRecentByConversation(
    conversationId: string,
    limit: number,
  ): Promise<{ data: OmniMessage[] }> {
    const filter = { conversationId };
    const sort: Record<string, SortOrder> = { createdAt: -1 };

    const items = await this.model
      .find(filter)
      .sort(sort)
      .limit(Math.max(1, limit))
      .lean()
      .exec();

    // Reverse so oldest first for display
    const reversed = [...items].reverse();
    const data = reversed.map((doc) => OmniMessageMapper.toDomain(doc as any));

    return { data };
  }

  /**
   * Check if a message with a given external ID already exists (deduplication).
   */
  async existsByExternalId(
    tenantId: string,
    externalMessageId: string,
  ): Promise<boolean> {
    const doc = await this.model
      .findOne({ tenantId, externalMessageId })
      .select('_id')
      .lean()
      .exec();
    return !!doc;
  }

  async updateStatus(
    id: string,
    status: string,
    externalId?: string,
  ): Promise<void> {
    const update: any = { status };
    if (externalId) {
      update.externalMessageId = externalId;
    }
    await this.model.findByIdAndUpdate(id, { $set: update }).exec();
  }

  /**
   * Update the media proxy URL on a message after async caching completes.
   * Called by MediaCacheProcessor when the background download finishes.
   */
  async updateMediaProxyUrl(id: string, mediaProxyUrl: string): Promise<void> {
    await this.model.findByIdAndUpdate(id, { $set: { mediaProxyUrl } }).exec();
  }

  /**
   * Fetch messages from multiple conversations combined, sorted oldest-first.
   * Used for cross-conversation customer history.
   */
  async findByConversationIds(
    conversationIds: string[],
    page: number,
    limit: number,
  ): Promise<PaginationResponseDto<OmniMessage>> {
    const filter = { conversationId: { $in: conversationIds } };
    const sort: Record<string, SortOrder> = { createdAt: 1 };

    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * limit;

    const [items, total] = await Promise.all([
      this.model.find(filter).sort(sort).skip(skip).limit(limit).exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return pagination(
      items.map((doc) => OmniMessageMapper.toDomain(doc)),
      total,
      { page: safePage, limit },
    );
  }

  async findByConversationIdsChronological(
    conversationIds: string[],
    limitPerConversation: number,
  ): Promise<Record<string, OmniMessage[]>> {
    const safeLimit = Math.max(1, Math.min(limitPerConversation, 200));

    const entries = await Promise.all(
      conversationIds.map(async (conversationId) => {
        const docs = await this.model
          .find({ conversationId })
          .sort({ createdAt: 1, _id: 1 })
          .limit(safeLimit)
          .exec();

        return [
          conversationId,
          docs.map((doc) => OmniMessageMapper.toDomain(doc)),
        ] as const;
      }),
    );

    return Object.fromEntries(entries);
  }

  async findByConversationIdWithCursor(params: {
    conversationId: string;
    limit: number;
    direction: 'past' | 'future';
    cursor?: { createdAt: Date; id: string } | null;
  }): Promise<{
    data: OmniMessage[];
    hasMore: boolean;
    cursor: { createdAt: Date; id: string } | null;
  }> {
    const safeLimit = Math.max(1, Math.min(params.limit, 200));
    const filter: Record<string, any> = {
      conversationId: params.conversationId,
    };

    if (params.cursor) {
      const cursorObjectId = Types.ObjectId.isValid(params.cursor.id)
        ? new Types.ObjectId(params.cursor.id)
        : null;

      if (!cursorObjectId) {
        filter.createdAt =
          params.direction === 'past'
            ? { $lt: params.cursor.createdAt }
            : { $gt: params.cursor.createdAt };
      } else if (params.direction === 'past') {
        filter.$or = [
          { createdAt: { $lt: params.cursor.createdAt } },
          { createdAt: params.cursor.createdAt, _id: { $lt: cursorObjectId } },
        ];
      } else {
        filter.$or = [
          { createdAt: { $gt: params.cursor.createdAt } },
          { createdAt: params.cursor.createdAt, _id: { $gt: cursorObjectId } },
        ];
      }
    }

    const sort: Record<string, SortOrder> =
      params.direction === 'past'
        ? { createdAt: -1, _id: -1 }
        : { createdAt: 1, _id: 1 };

    const docs = await this.model
      .find(filter)
      .sort(sort)
      .limit(safeLimit + 1)
      .exec();

    const hasMore = docs.length > safeLimit;
    const trimmed = hasMore ? docs.slice(0, safeLimit) : docs;
    const ordered =
      params.direction === 'past' ? [...trimmed].reverse() : trimmed;
    const data = ordered.map((doc) => OmniMessageMapper.toDomain(doc));

    const edge =
      params.direction === 'past'
        ? (data[0] ?? null)
        : (data[data.length - 1] ?? null);

    return {
      data,
      hasMore,
      cursor: edge
        ? {
            createdAt: edge.createdAt,
            id: edge.id,
          }
        : null,
    };
  }

  /**
   * Fetch messages by an array of IDs.
   * Used by LinkedMessagesPanel to display chat messages linked to a Deal or Ticket.
   */
  async findByIds(ids: string[]): Promise<OmniMessage[]> {
    const safeIds = Array.from(new Set(ids)).filter((id) =>
      Types.ObjectId.isValid(id),
    );
    if (safeIds.length === 0) return [];

    const docs = await this.model
      .find({ _id: { $in: safeIds } })
      .sort({ createdAt: 1 })
      .lean()
      .exec();

    return docs.map((doc) => OmniMessageMapper.toDomain(doc as any));
  }
}
