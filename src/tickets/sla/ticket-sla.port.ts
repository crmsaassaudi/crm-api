import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../infrastructure/persistence/document/entities/ticket.schema';
import type {
  SlaSubjectContext,
  SlaSubjectPort,
  SlaSubjectProjection,
} from '../../sla-policies/clock/sla-subject.port';
import type { SlaSubjectType } from '../../sla-policies/clock/sla-clock.schema';

/**
 * How the SLA engine reads and writes a ticket.
 *
 * It is the only writer of `firstResponseDueAt`, `resolutionDueAt` and
 * `isSlaBreached` — the three columns the ticket list filters on and the SLA
 * report counts.
 *
 * Writes go through the raw model rather than TicketsService: this runs from a
 * cron and from event handlers with no request behind them, and it must not
 * re-enter the automation outbox or the status-transition guard.
 */
@Injectable()
export class TicketSlaPort implements SlaSubjectPort {
  readonly subjectType: SlaSubjectType = 'ticket';

  constructor(
    @InjectModel(TicketSchemaClass.name)
    private readonly tickets: Model<TicketSchemaDocument>,
  ) {}

  /**
   * The ticket's priority is the segment an SLA target is chosen by — this is
   * what makes "High priority → first response within 15 minutes" expressible.
   */
  async loadContext(
    tenantId: string,
    ticketId: string,
  ): Promise<SlaSubjectContext | null> {
    const ticket = await this.tickets
      .findOne({ _id: ticketId, tenantId, deletedAt: null })
      .select({ priority: 1 })
      .lean()
      .exec();
    if (!ticket) return null;
    return { segment: ticket.priority ?? null };
  }

  async project(
    tenantId: string,
    ticketId: string,
    projection: SlaSubjectProjection,
  ): Promise<void> {
    // Key-by-key, because the engine sends deadlines, the policy id and the
    // breach flag on different occasions.
    const set: Record<string, unknown> = {};
    if ('firstResponseDueAt' in projection) {
      set.firstResponseDueAt = projection.firstResponseDueAt;
    }
    if ('resolutionDueAt' in projection) {
      set.resolutionDueAt = projection.resolutionDueAt;
    }
    if ('policyId' in projection) {
      set.slaPolicyId = projection.policyId
        ? new Types.ObjectId(projection.policyId)
        : null;
    }
    if ('breachedAt' in projection) {
      // Sticky for the life of the cycle: a supervisor filtering "breached
      // today" means "missed a deadline", not "is missing one right now".
      // Reopen is the only thing that clears it, by sending an explicit null.
      set.isSlaBreached = projection.breachedAt !== null;
    }
    if (Object.keys(set).length === 0) return;

    await this.tickets
      .updateOne({ _id: ticketId, tenantId }, { $set: set })
      .exec();
  }
}
