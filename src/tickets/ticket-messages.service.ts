import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { FilterQuery, Model, Types } from 'mongoose';

import {
  TicketMessageDocument,
  TicketMessageKind,
  TicketMessageSchemaClass,
} from './infrastructure/persistence/document/entities/ticket-message.schema';
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from './infrastructure/persistence/document/entities/ticket.schema';
import { FileSchemaClass } from '../files/infrastructure/persistence/document/entities/file.schema';
import {
  CreateTicketMessageDto,
  TicketTimelineQueryDto,
  UpdateTicketMessageDto,
} from './dto/ticket-message.dto';
import { TicketEvents, TicketRepliedEvent } from './domain/ticket-events';
import { EntityAuditService } from '../common/audit/entity-audit.service';

/** Shape returned to the timeline UI. */
export interface TicketTimelineEntry {
  id: string;
  kind: TicketMessageKind;
  authorType: 'agent' | 'customer' | 'system';
  authorId: string | null;
  author: { id: string; name: string; avatar?: string } | null;
  body: string;
  attachments: Array<{
    id: string;
    fileName: string;
    mimeType?: string;
    fileSize?: number;
  }>;
  systemPayload: Record<string, unknown> | null;
  editedAt?: Date;
  createdAt: Date;
}

/**
 * The ticket's conversation and its timeline — how an agent answers a
 * customer, leaves an internal note and attaches a file.
 *
 * System entries live in the same collection as replies and notes on purpose:
 * the timeline is one ordered, cursor-paginated read, not a merge of three
 * sources at render time.
 */
@Injectable()
export class TicketMessagesService {
  private readonly logger = new Logger(TicketMessagesService.name);

  constructor(
    @InjectModel(TicketMessageSchemaClass.name)
    private readonly messages: Model<TicketMessageDocument>,
    @InjectModel(TicketSchemaClass.name)
    private readonly tickets: Model<TicketSchemaDocument>,
    @InjectModel(FileSchemaClass.name)
    private readonly files: Model<any>,
    private readonly cls: ClsService,
    private readonly events: EventEmitter2,
    private readonly entityAudit: EntityAuditService,
  ) {}

  // READS

  /**
   * One page of a ticket's timeline, oldest-first within the page.
   *
   * Paged backwards from `before` so "load older" is an index range scan rather
   * than a growing `skip`, then reversed so the caller can append without
   * re-sorting.
   */
  async timeline(
    ticketId: string,
    query: TicketTimelineQueryDto,
  ): Promise<{ entries: TicketTimelineEntry[]; nextCursor: string | null }> {
    const limit = query.limit ?? 30;
    const filter: FilterQuery<TicketMessageSchemaClass> = {
      tenantId: this.tenantId(),
      ticketId: new Types.ObjectId(ticketId),
      deletedAt: null,
    };
    if (query.view === 'conversation') {
      filter.kind = { $in: ['reply', 'note'] } as any;
    }
    if (query.before) {
      filter._id = { $lt: new Types.ObjectId(query.before) } as any;
    }

    const docs = await this.messages
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate('authorId', 'firstName lastName photo')
      .lean()
      .exec();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const attachments = await this.loadAttachments(page);

    return {
      entries: page
        .reverse()
        .map((doc) => this.toEntry(doc as any, attachments)),
      nextCursor: hasMore ? String(page[0]._id) : null,
    };
  }

  /**
   * Resolve every attachment referenced by the page in one query.
   *
   * Per-message lookups would be N+1 against a collection that is already the
   * heaviest read on the detail page.
   */
  private async loadAttachments(
    docs: Array<{ attachmentIds?: any[] }>,
  ): Promise<Map<string, any>> {
    const ids = docs.flatMap((doc) => doc.attachmentIds ?? []);
    if (ids.length === 0) return new Map();
    const files = await this.files
      .find({
        _id: { $in: ids },
        tenantId: this.tenantId(),
        isDeleted: { $ne: true },
      })
      .select({ fileName: 1, mimeType: 1, fileSize: 1 })
      .lean()
      .exec();
    return new Map(files.map((file: any) => [String(file._id), file]));
  }

  private toEntry(
    doc: any,
    attachments: Map<string, any>,
  ): TicketTimelineEntry {
    const author = doc.authorId;
    const isPopulated = author && typeof author === 'object' && author._id;
    return {
      id: String(doc._id),
      kind: doc.kind,
      authorType: doc.authorType,
      authorId: isPopulated
        ? String(author._id)
        : author
          ? String(author)
          : null,
      author: isPopulated
        ? {
            id: String(author._id),
            name:
              [author.firstName, author.lastName].filter(Boolean).join(' ') ||
              'Unknown',
            avatar: author.photo,
          }
        : null,
      body: doc.body,
      attachments: (doc.attachmentIds ?? [])
        .map((id: any) => attachments.get(String(id)))
        .filter(Boolean)
        .map((file: any) => ({
          id: String(file._id),
          fileName: file.fileName ?? 'attachment',
          mimeType: file.mimeType,
          fileSize: file.fileSize,
        })),
      systemPayload: doc.systemPayload ?? null,
      editedAt: doc.editedAt,
      createdAt: doc.createdAt,
    };
  }

  // WRITES

  /**
   * Post an agent reply or an internal note.
   *
   * The caller has already passed `tickets:reply` (or `tickets:note`) and the
   * record-level ACL on the ticket; what is enforced here is what the
   * controller cannot see: that the ticket is live, and that every attachment
   * belongs to this tenant.
   */
  async create(
    ticketId: string,
    dto: CreateTicketMessageDto,
  ): Promise<TicketTimelineEntry> {
    const tenantId = this.tenantId();
    const authorId = this.userId();
    if (!authorId) {
      throw new ForbiddenException('An authenticated agent is required');
    }

    const ticket = await this.tickets
      .findOne({ _id: ticketId, tenantId, deletedAt: null })
      .select({ _id: 1, firstRespondedAt: 1 })
      .lean()
      .exec();
    if (!ticket) throw new NotFoundException(`Ticket ${ticketId} not found`);

    await this.assertAttachmentsOwned(dto.attachmentIds);

    const created = await this.messages.create({
      tenantId,
      ticketId,
      kind: dto.kind,
      authorType: 'agent',
      authorId,
      body: dto.body,
      attachmentIds: dto.attachmentIds ?? [],
      createdById: authorId,
    });

    // A public reply is the event the first-response SLA is measured against.
    // An internal note is not: writing one must never mark the customer as
    // answered.
    if (dto.kind === 'reply') {
      await this.recordFirstResponse(ticketId, authorId, created.createdAt);
      this.events.emit(TicketEvents.REPLIED, {
        tenantId,
        ticketId,
        messageId: String(created._id),
        authorId,
        respondedAt: created.createdAt,
      } satisfies TicketRepliedEvent);
    }

    this.entityAudit.emit({
      entity: 'ticket',
      entityType: 'TICKET',
      entityId: ticketId,
      kind: 'updated',
      newSnapshot: {
        ticketMessage: {
          id: String(created._id),
          kind: dto.kind,
          attachments: dto.attachmentIds?.length ?? 0,
        },
      } as any,
    });

    const populated = await this.messages
      .findById(created._id)
      .populate('authorId', 'firstName lastName photo')
      .lean()
      .exec();
    return this.toEntry(
      populated as any,
      await this.loadAttachments([populated as any]),
    );
  }

  /**
   * Stamp `firstRespondedAt` the first time an agent replies.
   *
   * Conditional on the field still being unset, in one atomic write: two agents
   * replying at the same moment must not race the stamp later and later. The
   * SLA clock settles off the emitted event, not off this write.
   */
  private async recordFirstResponse(
    ticketId: string,
    agentId: string,
    at: Date,
  ): Promise<void> {
    const result = await this.tickets
      .updateOne(
        {
          _id: ticketId,
          tenantId: this.tenantId(),
          firstRespondedAt: null,
        },
        { $set: { firstRespondedAt: at, firstRespondedById: agentId } },
      )
      .exec();
    if (result.modifiedCount > 0) {
      this.events.emit(TicketEvents.FIRST_RESPONDED, {
        tenantId: this.tenantId(),
        ticketId,
        messageId: '',
        authorId: agentId,
        respondedAt: at,
      } satisfies TicketRepliedEvent);
    }
  }

  private async assertAttachmentsOwned(ids?: string[]): Promise<void> {
    if (!ids?.length) return;
    const count = await this.files
      .countDocuments({
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
        tenantId: this.tenantId(),
        isDeleted: { $ne: true },
      })
      .exec();
    if (count !== new Set(ids).size) {
      throw new BadRequestException(
        'One or more attachments do not exist in this tenant',
      );
    }
  }

  /**
   * Edit one's own reply or note.
   *
   * Author-only and never for `system` entries: the timeline is what an audit
   * reads back, so a supervisor rewriting an agent's words — or anyone
   * rewriting what the platform recorded — would make it useless as evidence.
   */
  async update(
    ticketId: string,
    messageId: string,
    dto: UpdateTicketMessageDto,
  ): Promise<TicketTimelineEntry> {
    const message = await this.ownEditableMessage(ticketId, messageId);
    message.body = dto.body;
    message.editedAt = new Date();
    await message.save();

    const populated = await this.messages
      .findById(message._id)
      .populate('authorId', 'firstName lastName photo')
      .lean()
      .exec();
    return this.toEntry(
      populated as any,
      await this.loadAttachments([populated as any]),
    );
  }

  /** Soft-delete one's own reply or note. The entry stays for the audit trail. */
  async remove(ticketId: string, messageId: string): Promise<void> {
    const message = await this.ownEditableMessage(ticketId, messageId);
    message.deletedAt = new Date();
    await message.save();
  }

  private async ownEditableMessage(
    ticketId: string,
    messageId: string,
  ): Promise<TicketMessageDocument> {
    const message = await this.messages
      .findOne({
        _id: messageId,
        ticketId,
        tenantId: this.tenantId(),
        deletedAt: null,
      })
      .exec();
    if (!message) throw new NotFoundException('Timeline entry not found');
    if (message.kind === 'system') {
      throw new ForbiddenException('System timeline entries cannot be edited');
    }
    if (String(message.authorId ?? '') !== String(this.userId() ?? '')) {
      throw new ForbiddenException('Only the author can edit this entry');
    }
    return message;
  }

  /**
   * Append a system entry.
   *
   * Best-effort by design: the timeline narrates a change that has already
   * committed, so failing to narrate it must not fail the change. A missing
   * line is recoverable; a rolled-back status transition is not.
   */
  async appendSystem(params: {
    tenantId: string;
    ticketId: string;
    body: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.messages.create({
        tenantId: params.tenantId,
        ticketId: params.ticketId,
        kind: 'system',
        authorType: 'system',
        authorId: null,
        body: params.body,
        systemPayload: params.payload ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to append system timeline entry for ticket ${params.ticketId}: ${(error as Error).message}`,
      );
    }
  }

  /** Append a customer message mirrored from the linked omni conversation. */
  async appendCustomerMessage(params: {
    tenantId: string;
    ticketId: string;
    body: string;
    attachmentIds?: string[];
  }): Promise<void> {
    try {
      await this.messages.create({
        tenantId: params.tenantId,
        ticketId: params.ticketId,
        kind: 'reply',
        authorType: 'customer',
        authorId: null,
        body: params.body,
        attachmentIds: params.attachmentIds ?? [],
      });
    } catch (error) {
      this.logger.warn(
        `Failed to mirror customer message onto ticket ${params.ticketId}: ${(error as Error).message}`,
      );
    }
  }

  private tenantId(): string {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!tenantId) throw new Error('Tenant context is required');
    return String(tenantId);
  }

  private userId(): string | undefined {
    return this.cls.get('userId') ?? this.cls.get('user.id');
  }
}
