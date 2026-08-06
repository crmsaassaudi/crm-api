import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { BusinessHoursService } from '../../omni-inbound/services/business-hours.service';
import { ClsService } from 'nestjs-cls';
import { OmniEvents } from '../../omni-inbound/domain/omni-events';
import type { SlaMetric } from '../../omni-inbound/domain/omni-conversation';
import { SlaPolicyRepository } from '../infrastructure/persistence/document/repositories/sla-policy.repository';
import {
  SlaClockDocument,
  SlaClockSchemaClass,
  SlaSubjectType,
} from './sla-clock.schema';
import {
  SLA_SUBJECT_PORTS,
  SlaSubjectPort,
  SlaSubjectProjection,
} from './sla-subject.port';
import { SlaEvents } from './sla-events';

/** How many due clocks one cron tick may breach. */
const BREACH_BATCH_SIZE = 500;

/** Identifies the thing a clock measures. */
interface SlaSubject {
  type: SlaSubjectType;
  id: string;
}

/**
 * SlaClockService — the single authority on SLA state, for every kind of work.
 *
 * A clock per (subject, metric, cycle): `running → paused → running → met |
 * breached | cancelled`. Pausing while the work waits on the customer is what
 * makes the numbers defensible — an agent is not late because the customer
 * took the weekend to reply.
 *
 * There must only ever be one engine: two produce two sets of breach flags, of
 * which only one reaches a consumer. `SlaSubjectPort` keeps a new subject type
 * an adapter rather than a fork.
 */
@Injectable()
export class SlaClockService {
  private readonly logger = new Logger(SlaClockService.name);
  private readonly ports = new Map<SlaSubjectType, SlaSubjectPort>();

  constructor(
    @InjectModel(SlaClockSchemaClass.name)
    private readonly clocks: Model<SlaClockDocument>,
    private readonly policies: SlaPolicyRepository,
    private readonly businessHours: BusinessHoursService,
    private readonly events: EventEmitter2,
    private readonly cls: ClsService,
    @Optional()
    @Inject(SLA_SUBJECT_PORTS)
    subjectPorts: SlaSubjectPort[] = [],
  ) {
    for (const port of subjectPorts) this.ports.set(port.subjectType, port);
  }

  // OMNI CONVERSATION BINDINGS

  @OnEvent(OmniEvents.CONVERSATION_CREATED, { async: true })
  async onConversationCreated(event: any): Promise<void> {
    await this.startResponseAndResolutionClocks(event.tenantId, {
      type: 'conversation',
      id: event.conversationId,
    });
  }

  /**
   * A reopened conversation owes the customer a fresh first response.
   *
   * The engine this replaced bound only to `created`, so a reopened conversation
   * carried the previous cycle's stale deadline — or none at all, which reads as
   * "no SLA applies" on the screen that exists to show which customers are
   * waiting.
   */
  @OnEvent(OmniEvents.CONVERSATION_REOPENED, { async: true })
  async onConversationReopened(event: any): Promise<void> {
    await this.startResponseAndResolutionClocks(event.tenantId, {
      type: 'conversation',
      id: event.conversationId,
    });
  }

  @OnEvent(OmniEvents.MESSAGE_PERSISTED, { async: true })
  async onInboundMessage(event: any): Promise<void> {
    if (event.senderType !== 'customer') return;
    await this.onCustomerTurn(event.tenantId, {
      type: 'conversation',
      id: event.conversationId,
    });
  }

  @OnEvent(OmniEvents.MESSAGE_SENT, { async: true })
  async onAgentReply(event: any): Promise<void> {
    if (event.senderType && event.senderType !== 'agent') return;
    // On an agent message `senderId` is the agent's user id (OutboundService
    // sets it from `agentId`); on a bot message it is `bot:<provider>`, which
    // the guard above has already excluded.
    await this.onAgentTurn(
      event.tenantId,
      { type: 'conversation', id: event.conversationId },
      new Date(),
      event.senderId ? String(event.senderId) : null,
    );
  }

  @OnEvent(OmniEvents.CONVERSATION_STATUS_CHANGED, { async: true })
  async onStatusChanged(event: any): Promise<void> {
    const status = event.newStatus ?? event.status;
    const subject: SlaSubject = {
      type: 'conversation',
      id: event.conversationId,
    };
    if (status === 'pending') {
      await this.pause(event.tenantId, subject);
    } else if (status === 'open') {
      await this.resume(event.tenantId, subject);
    } else if (status === 'resolved' || status === 'closed') {
      await this.complete(event.tenantId, subject);
    }
    await this.projectPendingDeadline(event.tenantId, subject);
  }

  // SUBJECT-AGNOSTIC OPERATIONS
  //
  // The ticket module drives these directly from its own lifecycle events
  // (see TicketSlaProjector) rather than through an omni event shape.

  /** Open the first-response and resolution clocks for a new piece of work. */
  async startResponseAndResolutionClocks(
    tenantId: string,
    subject: SlaSubject,
  ): Promise<void> {
    await runWithTenantContext(this.cls, tenantId, async () => {
      await Promise.all([
        this.startMetric(tenantId, subject, 'first_response'),
        this.startMetric(tenantId, subject, 'resolution'),
      ]);
      await this.projectPendingDeadline(tenantId, subject);
    });
  }

  /**
   * The customer said something. Owes a response; may open a new cycle.
   *
   * `first_response` only counts once — a customer's second message is a
   * `next_response` turn, not a second first response.
   */
  async onCustomerTurn(tenantId: string, subject: SlaSubject): Promise<void> {
    await runWithTenantContext(this.cls, tenantId, async () => {
      // The persisted-message event is durable, so it also repairs a missed
      // asynchronous creation projection.
      await this.startMetric(tenantId, subject, 'resolution');
      const firstOpen = await this.clocks
        .exists({
          tenantId,
          subjectType: subject.type,
          subjectId: subject.id,
          metric: 'first_response',
          status: { $in: ['running', 'paused'] },
        })
        .exec();
      if (firstOpen) return;

      const firstClock = await this.clocks
        .findOne({
          tenantId,
          subjectType: subject.type,
          subjectId: subject.id,
          metric: 'first_response',
        })
        .sort({ cycle: -1 })
        .lean()
        .exec();
      // Creation and first inbound processing run asynchronously. If the
      // first-response projection has not landed yet, create/repair it and do
      // not mistake the customer's initial message for a next-response turn.
      await this.startMetric(
        tenantId,
        subject,
        firstClock ? 'next_response' : 'first_response',
      );
      await this.projectPendingDeadline(tenantId, subject);
    });
  }

  /** An agent answered. Settles whichever response clock was owed. */
  async onAgentTurn(
    tenantId: string,
    subject: SlaSubject,
    respondedAt: Date,
    responderId: string | null = null,
  ): Promise<void> {
    // The business fact first, independent of whether a policy is configured:
    // First Response Time has to be measurable in a tenant that has written no
    // SLA policy at all.
    const port = this.ports.get(subject.type);
    if (port?.recordAgentResponse) {
      await runWithTenantContext(this.cls, tenantId, () =>
        port.recordAgentResponse!(
          tenantId,
          subject.id,
          respondedAt,
          responderId,
        ),
      );
    }

    await this.settleClocks(
      {
        tenantId,
        subjectType: subject.type,
        subjectId: subject.id,
        metric: { $in: ['first_response', 'next_response'] },
        status: { $in: ['running', 'paused'] },
      },
      respondedAt,
    );
    await this.projectPendingDeadline(tenantId, subject);
  }

  async startMetric(
    tenantId: string,
    subject: SlaSubject,
    metric: SlaMetric,
  ): Promise<SlaClockDocument | null> {
    const port = this.ports.get(subject.type);
    const context = port
      ? await port.loadContext(tenantId, subject.id)
      : { segment: null };
    if (!context) return null;

    const policies = await this.policies.findApplicable(
      tenantId,
      subject.type,
      metric,
    );
    const policy = policies[0];
    // A target whose segment matches the subject wins; the catch-all backs it.
    // Selecting `targets[0]` unconditionally — as this did — meant a policy
    // that spelled out per-priority targets applied whichever one happened to
    // be stored first to every ticket in the tenant.
    const target =
      policy?.targets.find(
        (entry) =>
          entry.segment != null &&
          context.segment != null &&
          entry.segment.toUpperCase() === context.segment.toUpperCase(),
      ) ?? policy?.targets.find((entry) => entry.segment == null);
    if (!policy || !target) return null;

    const targetMinutes = this.toMinutes(target.timeValue, target.timeUnit);
    const latest = await this.clocks
      .findOne({
        tenantId,
        subjectType: subject.type,
        subjectId: subject.id,
        metric,
      })
      .sort({ cycle: -1 })
      .lean()
      .exec();
    if (latest && ['running', 'paused'].includes(latest.status)) {
      return latest as any;
    }

    // `first_response` and `resolution` are once-per-subject, so a settled
    // clock is the final answer and must not be restarted — except on reopen,
    // which cancels the old cycle first and so leaves nothing settled behind.
    if (metric !== 'next_response' && latest && latest.status !== 'cancelled') {
      return latest as any;
    }

    const cycle = (latest?.cycle ?? 0) + 1;
    const dueAt = await this.businessHours.calculateSlaDeadline(
      tenantId,
      targetMinutes,
    );
    try {
      const created = await this.clocks.create({
        tenantId,
        subjectType: subject.type,
        subjectId: subject.id,
        policyId: policy.id,
        metric,
        cycle,
        status: 'running',
        targetMinutes,
        startedAt: new Date(),
        dueAt,
        segment: target.segment ?? null,
      });
      // Record which policy governs the subject, so a report can tell
      // "compliant" from "never measured".
      await this.project(tenantId, subject, { policyId: policy.id });
      return created;
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      return this.clocks
        .findOne({
          tenantId,
          subjectType: subject.type,
          subjectId: subject.id,
          metric,
          cycle,
        })
        .exec();
    }
  }

  async pause(tenantId: string, subject: SlaSubject): Promise<number> {
    const now = new Date();
    const running = await this.clocks
      .find({
        tenantId,
        subjectType: subject.type,
        subjectId: subject.id,
        status: 'running',
      })
      .exec();
    let paused = 0;
    for (const clock of running) {
      const remainingMinutes =
        await this.businessHours.calculateBusinessMinutesBetween(
          tenantId,
          now,
          clock.dueAt,
        );
      const result = await this.clocks
        .updateOne(
          { _id: clock._id, status: 'running' },
          {
            $set: {
              status: 'paused',
              pausedAt: now,
              remainingMinutesAtPause: remainingMinutes,
            },
          },
        )
        .exec();
      paused += result.modifiedCount;
    }
    return paused;
  }

  async resume(tenantId: string, subject: SlaSubject): Promise<number> {
    const paused = await this.clocks
      .find({
        tenantId,
        subjectType: subject.type,
        subjectId: subject.id,
        status: 'paused',
      })
      .exec();
    let resumed = 0;
    for (const clock of paused) {
      const now = new Date();
      const dueAt = await this.businessHours.calculateSlaDeadline(
        tenantId,
        clock.remainingMinutesAtPause ?? clock.targetMinutes,
      );
      const result = await this.clocks
        .updateOne(
          { _id: clock._id, status: 'paused' },
          {
            $set: {
              status: 'running',
              dueAt,
              pausedAt: null,
              remainingMinutesAtPause: null,
            },
            $inc: {
              totalPausedMs: clock.pausedAt
                ? now.getTime() - clock.pausedAt.getTime()
                : 0,
            },
          },
        )
        .exec();
      resumed += result.modifiedCount;
    }
    return resumed;
  }

  /** The work is done: settle resolution, cancel any response clock still owed. */
  async complete(tenantId: string, subject: SlaSubject): Promise<void> {
    const now = new Date();
    await this.settleClocks(
      {
        tenantId,
        subjectType: subject.type,
        subjectId: subject.id,
        metric: 'resolution',
        status: { $in: ['running', 'paused'] },
      },
      now,
    );
    await this.clocks
      .updateMany(
        {
          tenantId,
          subjectType: subject.type,
          subjectId: subject.id,
          metric: { $in: ['first_response', 'next_response'] },
          status: { $in: ['running', 'paused'] },
        },
        { $set: { status: 'cancelled' } },
      )
      .exec();
    await this.projectPendingDeadline(tenantId, subject);
  }

  /**
   * Cancel every open clock and start a fresh cycle — what a reopen means.
   *
   * Without the cancel, `startMetric` sees a settled once-per-subject clock and
   * refuses to restart, so a reopened ticket carries the previous cycle's
   * expired deadline and breaches instantly.
   */
  async restartCycle(tenantId: string, subject: SlaSubject): Promise<void> {
    await this.clocks
      .updateMany(
        {
          tenantId,
          subjectType: subject.type,
          subjectId: subject.id,
          status: { $in: ['running', 'paused', 'met', 'breached'] },
        },
        { $set: { status: 'cancelled' } },
      )
      .exec();
    await this.project(tenantId, subject, { breachedAt: null });
    await this.startResponseAndResolutionClocks(tenantId, subject);
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async breachDueClocks(): Promise<number> {
    const candidates = await this.clocks
      .find({ status: 'running', dueAt: { $lte: new Date() } })
      .select('_id tenantId subjectType subjectId policyId metric cycle dueAt')
      .sort({ dueAt: 1, _id: 1 })
      .limit(BREACH_BATCH_SIZE)
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();

    // A full batch means the scan is behind, which delays every breach in the
    // backlog — countable, because a silently lagging SLA monitor looks exactly
    // like a compliant contact centre.
    if (candidates.length === BREACH_BATCH_SIZE) {
      this.logger.warn(
        `SLA breach scan hit its ${BREACH_BATCH_SIZE}-clock batch limit — ` +
          'breach detection is lagging.',
      );
    }

    let breached = 0;
    for (const candidate of candidates) {
      const clock = await this.clocks
        .findOneAndUpdate(
          { _id: candidate._id, status: 'running' },
          { $set: { status: 'breached', breachedAt: new Date() } },
          { new: true },
        )
        .setOptions({ isPlatformQuery: true })
        .exec();
      if (!clock) continue;
      await this.announceBreach(clock);
      breached++;
    }
    return breached;
  }

  listForSubject(
    tenantId: string,
    subjectType: SlaSubjectType,
    subjectId: string,
  ): Promise<SlaClockDocument[]> {
    return this.clocks
      .find({ tenantId, subjectType, subjectId })
      .sort({ metric: 1, cycle: -1 })
      .lean()
      .exec() as any;
  }

  // Internals

  private async settleClocks(query: Record<string, any>, metAt: Date) {
    const open = await this.clocks.find(query).exec();
    for (const clock of open) {
      const breached =
        clock.status === 'running' && clock.dueAt.getTime() < metAt.getTime();
      const updated = await this.clocks
        .findOneAndUpdate(
          { _id: clock._id, status: clock.status },
          {
            $set: breached
              ? { status: 'breached', breachedAt: metAt }
              : { status: 'met', metAt },
          },
          { new: true },
        )
        .exec();
      if (updated && breached) await this.announceBreach(updated);
    }
  }

  /**
   * Publish a breach once, on the one event name the rest of the system listens
   * to: escalation policies, the activity trail, the daily metrics projection
   * and the inbox socket all consume `SlaEvents.BREACHED`.
   */
  private async announceBreach(clock: SlaClockDocument): Promise<void> {
    const tenantId = String(clock.tenantId);
    const subject: SlaSubject = {
      type: clock.subjectType,
      id: String(clock.subjectId),
    };
    const breachedAt = clock.breachedAt ?? new Date();

    await this.project(tenantId, subject, {
      firstResponseDueAt: null,
      resolutionDueAt: null,
      breachedAt,
    });
    await this.projectPendingDeadline(tenantId, subject);

    this.events.emit(SlaEvents.BREACHED, {
      tenantId,
      subjectType: subject.type,
      subjectId: subject.id,
      clockId: String(clock._id),
      slaPolicyId: String(clock.policyId),
      metric: clock.metric,
      cycle: clock.cycle,
      dueAt: clock.dueAt,
      breachedAt,
    });
  }

  /**
   * Refresh the subject's pending-deadline projection.
   *
   * Per metric, so the list view can show "first response due in 4m" and
   * "resolution due tomorrow" independently, and so a deadline update never
   * resets the sticky breach flag.
   */
  private async projectPendingDeadline(
    tenantId: string,
    subject: SlaSubject,
  ): Promise<void> {
    const running = await this.clocks
      .find({
        tenantId,
        subjectType: subject.type,
        subjectId: subject.id,
        status: 'running',
      })
      .select('dueAt metric')
      .lean()
      .exec();

    const byMetric = new Map(
      running.map((clock) => [clock.metric, clock.dueAt]),
    );
    await this.project(tenantId, subject, {
      firstResponseDueAt:
        byMetric.get('first_response') ?? byMetric.get('next_response') ?? null,
      resolutionDueAt: byMetric.get('resolution') ?? null,
    });
  }

  private async project(
    tenantId: string,
    subject: SlaSubject,
    projection: SlaSubjectProjection,
  ): Promise<void> {
    const port = this.ports.get(subject.type);
    if (!port) return;
    await runWithTenantContext(this.cls, tenantId, () =>
      port.project(tenantId, subject.id, projection),
    );
  }

  private toMinutes(value: number, unit: string): number {
    if (unit === 'days') return value * 24 * 60;
    if (unit === 'hours') return value * 60;
    return value;
  }
}
