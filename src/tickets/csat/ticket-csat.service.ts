import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../infrastructure/persistence/document/entities/ticket.schema';
import {
  TicketEvents,
  TicketStatusChangedEvent,
} from '../domain/ticket-events';

/**
 * How long a survey link stays usable.
 *
 * Long enough for a customer to answer at their convenience, short enough that
 * a forwarded link is not a permanent write handle to the score.
 */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TicketCsatSurvey {
  ticketNumber: string;
  subject: string;
  alreadyAnswered: boolean;
}

/**
 * Customer satisfaction on a ticket — the writer behind `ticket.csatScore`,
 * which the report aggregation and the agent scorecard both read.
 *
 * Minting is automatic on resolution; delivery is not this service's job. It
 * emits `ticket.csat.requested` carrying the token, and whoever owns the
 * customer's channel — the reply composer, an automation email — sends the
 * link. Owning delivery here would mean picking one channel and silently
 * leaving every other customer unasked.
 */
@Injectable()
export class TicketCsatService {
  private readonly logger = new Logger(TicketCsatService.name);

  constructor(
    @InjectModel(TicketSchemaClass.name)
    private readonly tickets: Model<TicketSchemaDocument>,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Mint a survey token when a ticket reaches a terminal status.
   *
   * Once per ticket: `csatToken: null` in the filter means a reopened and
   * re-resolved ticket keeps its original survey rather than asking the
   * customer to rate the same case twice.
   */
  @OnEvent(TicketEvents.STATUS_CHANGED, { async: true })
  async onStatusChanged(event: TicketStatusChangedEvent): Promise<void> {
    if (!event.nextStatus.isTerminal) return;

    const token = randomUUID().replace(/-/g, '');
    const result = await this.tickets
      .findOneAndUpdate(
        {
          _id: event.ticketId,
          tenantId: event.tenantId,
          csatToken: null,
          csatScore: null,
        },
        {
          $set: {
            csatToken: token,
            csatTokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
          },
        },
        { new: true },
      )
      .select({ ticketNumber: 1, contactId: 1, ownerId: 1 })
      .lean()
      .exec();
    if (!result) return;

    this.events.emit('ticket.csat.requested', {
      tenantId: event.tenantId,
      ticketId: event.ticketId,
      ticketNumber: result.ticketNumber,
      contactId: result.contactId ? String(result.contactId) : null,
      agentId: result.ownerId ? String(result.ownerId) : null,
      token,
    });
    this.logger.log(`CSAT survey minted for ticket ${result.ticketNumber}`);
  }

  /** What the public survey page renders. Never exposes the ticket body. */
  async describe(token: string): Promise<TicketCsatSurvey> {
    const ticket = await this.loadByToken(token);
    return {
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      alreadyAnswered: ticket.csatScore != null,
    };
  }

  /**
   * Record the customer's rating.
   *
   * The token is spent on success, so a forwarded or replayed link cannot
   * overwrite a score that has already been given.
   */
  async submit(
    token: string,
    dto: { score: number; comment?: string },
  ): Promise<{ success: true }> {
    if (!Number.isInteger(dto.score) || dto.score < 1 || dto.score > 5) {
      throw new BadRequestException('score must be an integer from 1 to 5');
    }
    const ticket = await this.loadByToken(token);

    const result = await this.tickets
      .updateOne(
        { _id: ticket._id, csatToken: token },
        {
          $set: {
            csatScore: dto.score,
            csatComment: dto.comment?.slice(0, 2_000),
            csatSubmittedAt: new Date(),
            csatToken: null,
          },
        },
      )
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
    if (result.modifiedCount === 0) {
      throw new NotFoundException('This survey has already been answered');
    }

    this.events.emit('ticket.csat.submitted', {
      tenantId: String(ticket.tenantId),
      ticketId: String(ticket._id),
      score: dto.score,
    });
    return { success: true };
  }

  /**
   * Resolve a token to its ticket.
   *
   * `isPlatformQuery` because the caller is an unauthenticated customer with no
   * tenant context — the token itself is the scope, which is why it is a
   * 128-bit random value with a unique index and an expiry.
   */
  private async loadByToken(token: string): Promise<any> {
    if (!/^[0-9a-f]{32}$/.test(token)) {
      throw new NotFoundException('Survey link is not valid');
    }
    const ticket = await this.tickets
      .findOne({ csatToken: token })
      .select({
        _id: 1,
        tenantId: 1,
        ticketNumber: 1,
        subject: 1,
        csatScore: 1,
        csatTokenExpiresAt: 1,
      })
      .setOptions({ isPlatformQuery: true } as any)
      .lean()
      .exec();
    if (!ticket) throw new NotFoundException('Survey link is not valid');
    if (
      ticket.csatTokenExpiresAt &&
      ticket.csatTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new NotFoundException('This survey link has expired');
    }
    return ticket;
  }
}
