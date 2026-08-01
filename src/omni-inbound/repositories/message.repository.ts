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

/**
 * Canonical thread order: when the provider says the message was sent, then the
 * per-conversation ordinal, then `_id`.
 *
 * Not `createdAt` — that is when *we* wrote the row, which reflects queue and
 * retry timing rather than what the customer did. Sorting by it reordered
 * threads as soon as message processing ran concurrently.
 */
const THREAD_ORDER: Record<string, SortOrder> = {
  providerTimestamp: 1,
  sequence: 1,
  _id: 1,
};

const THREAD_ORDER_DESC: Record<string, SortOrder> = {
  providerTimestamp: -1,
  sequence: -1,
  _id: -1,
};

/** A message's position in {@link THREAD_ORDER}. */
export interface ThreadCursor {
  providerTimestamp: Date;
  sequence: number;
  id: string;
}

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
    // A single atomic operation rather than update-then-read: the read half of
    // the old pair could observe a *different* write than the one it had just
    // performed when two deliveries of the same webhook raced, so both callers
    // could come away believing they had inserted the message.
    const result = await this.model
      .findOneAndUpdate(
        {
          tenantId: data.tenantId,
          externalMessageId: data.externalMessageId,
        },
        { $setOnInsert: data },
        { upsert: true, new: true, includeResultMetadata: true },
      )
      .exec();

    const doc = result?.value;
    if (!doc) {
      throw new Error(
        `Failed to read upserted inbound message ${data.externalMessageId}`,
      );
    }

    return {
      message: OmniMessageMapper.toDomain(doc),
      inserted: !result.lastErrorObject?.updatedExisting,
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

    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * limit;

    const [items, total] = await Promise.all([
      this.model
        .find(filter)
        .sort(THREAD_ORDER_DESC)
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
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
    const items = await this.model
      .find({ conversationId })
      .sort(THREAD_ORDER_DESC)
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
   * Record a provider's delivery/read/failure report on an outbound message.
   */
  async applyDeliveryReceipt(
    id: string,
    receipt: {
      status: string;
      occurredAt: Date;
      errorCode?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    await this.model
      .findByIdAndUpdate(id, {
        $set: {
          status: receipt.status,
          [`metadata.delivery.${receipt.status}At`]: receipt.occurredAt,
          ...(receipt.errorCode
            ? { 'metadata.delivery.errorCode': receipt.errorCode }
            : {}),
          ...(receipt.errorMessage
            ? { 'metadata.delivery.errorMessage': receipt.errorMessage }
            : {}),
        },
      })
      .exec();
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

    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * limit;

    const [items, total] = await Promise.all([
      this.model.find(filter).sort(THREAD_ORDER).skip(skip).limit(limit).exec(),
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
          .sort(THREAD_ORDER)
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

  /**
   * The sort-key position of a message, for cursor pagination.
   *
   * Resolved from the anchor message rather than taken from the client, so the
   * cursor is always expressed in the same terms as the sort and cannot skip or
   * repeat rows because a caller sent a value from a different field.
   */
  async findCursorAnchor(messageId: string): Promise<ThreadCursor | null> {
    if (!Types.ObjectId.isValid(messageId)) return null;

    const doc = await this.model
      .findById(messageId)
      .select('providerTimestamp sequence')
      .lean()
      .exec();
    if (!doc) return null;

    return {
      id: messageId,
      providerTimestamp: doc.providerTimestamp ?? new Date(0),
      sequence: doc.sequence ?? 0,
    };
  }

  /**
   * Everything in a conversation sent after a point in time, oldest first.
   *
   * For "catch me up since I last polled" clients that track a timestamp rather
   * than a message id. Compares `providerTimestamp` so the boundary is in the
   * same terms as the ordering.
   */
  async findSentAfter(
    conversationId: string,
    since: Date,
    limit: number,
  ): Promise<OmniMessage[]> {
    const docs = await this.model
      .find({ conversationId, providerTimestamp: { $gt: since } })
      .sort(THREAD_ORDER)
      .limit(Math.max(1, Math.min(limit, 200)))
      .lean()
      .exec();

    return docs.map((doc) => OmniMessageMapper.toDomain(doc as any));
  }

  async findByConversationIdWithCursor(params: {
    conversationId: string;
    limit: number;
    direction: 'past' | 'future';
    cursor?: ThreadCursor | null;
  }): Promise<{
    data: OmniMessage[];
    hasMore: boolean;
    cursor: ThreadCursor | null;
  }> {
    const safeLimit = Math.max(1, Math.min(params.limit, 200));
    const filter: Record<string, any> = {
      conversationId: params.conversationId,
      ...this.buildCursorFilter(params.cursor, params.direction),
    };

    const sort = params.direction === 'past' ? THREAD_ORDER_DESC : THREAD_ORDER;

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
      cursor: edge ? await this.findCursorAnchor(edge.id) : null,
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

  /**
   * Everything strictly before (`past`) or after (`future`) the cursor's
   * position in {@link THREAD_ORDER} — each key compared only when the keys
   * ahead of it tie.
   */
  private buildCursorFilter(
    cursor: ThreadCursor | null | undefined,
    direction: 'past' | 'future',
  ): Record<string, any> {
    if (!cursor) return {};

    const cmp = direction === 'past' ? '$lt' : '$gt';
    const cursorObjectId = Types.ObjectId.isValid(cursor.id)
      ? new Types.ObjectId(cursor.id)
      : new Types.ObjectId();

    return {
      $or: [
        { providerTimestamp: { [cmp]: cursor.providerTimestamp } },
        {
          providerTimestamp: cursor.providerTimestamp,
          sequence: { [cmp]: cursor.sequence },
        },
        {
          providerTimestamp: cursor.providerTimestamp,
          sequence: cursor.sequence,
          _id: { [cmp]: cursorObjectId },
        },
      ],
    };
  }
}
