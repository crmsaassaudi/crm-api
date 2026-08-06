import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { BusinessHoursService } from '../../omni-inbound/services/business-hours.service';
import { ClsService } from 'nestjs-cls';
import { ConversationRepository } from '../../omni-inbound/repositories/conversation.repository';
import { OmniEvents } from '../../omni-inbound/domain/omni-events';
import type { SlaMetric } from '../../omni-inbound/domain/omni-conversation';
import { SlaPolicyRepository } from '../infrastructure/persistence/document/repositories/sla-policy.repository';
import { SlaClockDocument, SlaClockSchemaClass } from './sla-clock.schema';

/** How many due clocks one cron tick may breach. */
const BREACH_BATCH_SIZE = 500;

/**
 * SlaClockService — the single authority on SLA state.
 *
 * A clock per (conversation, metric, cycle) with an explicit lifecycle:
 * `running → paused → running → met | breached | cancelled`. Pausing while the
 * conversation waits on the customer is what makes the numbers defensible: an
 * agent is not late because the customer took the weekend to reply.
 *
 * This replaced a second, parallel implementation that stored deadlines directly
 * on the conversation and cancelled its breach job on `omni.outbound.message.sent`
 * — an event no code emits. Nothing cancelled, so every conversation still open at
 * its deadline was recorded as a first-response breach no matter how fast the
 * agent answered, and that flag was what fed escalations and every SLA report.
 * Two engines also meant two breach events, of which only the wrong one reached a
 * consumer. Hence one engine, one event
 * (`OmniEvents.CONVERSATION_SLA_BREACHED`), and a projection onto the
 * conversation so the inbox can filter without joining.
 */
@Injectable()
export class SlaClockService {
  private readonly logger = new Logger(SlaClockService.name);

  constructor(
    @InjectModel(SlaClockSchemaClass.name)
    private readonly clocks: Model<SlaClockDocument>,
    private readonly policies: SlaPolicyRepository,
    private readonly businessHours: BusinessHoursService,
    private readonly conversations: ConversationRepository,
    private readonly events: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  @OnEvent(OmniEvents.CONVERSATION_CREATED, { async: true })
  async onConversationCreated(event: any): Promise<void> {
    await this.startResponseAndResolutionClocks(
      event.tenantId,
      event.conversationId,
    );
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
    await this.startResponseAndResolutionClocks(
      event.tenantId,
      event.conversationId,
    );
  }

  @OnEvent(OmniEvents.MESSAGE_PERSISTED, { async: true })
  async onInboundMessage(event: any): Promise<void> {
    if (event.senderType !== 'customer') return;
    await runWithTenantContext(this.cls, event.tenantId, async () => {
      // The persisted-message event is durable, so it also repairs a missed
      // asynchronous conversation-created projection.
      await this.startMetric(
        event.tenantId,
        event.conversationId,
        'resolution',
      );
      const firstOpen = await this.clocks
        .exists({
          tenantId: event.tenantId,
          conversationId: event.conversationId,
          metric: 'first_response',
          status: { $in: ['running', 'paused'] },
        })
        .exec();
      if (firstOpen) return;

      const firstClock = await this.clocks
        .findOne({
          tenantId: event.tenantId,
          conversationId: event.conversationId,
          metric: 'first_response',
        })
        .sort({ cycle: -1 })
        .lean()
        .exec();
      // Creation and first inbound processing run asynchronously. If the
      // first-response projection has not landed yet, create/repair it and do
      // not mistake the customer's initial message for a next-response turn.
      if (!firstClock) {
        await this.startMetric(
          event.tenantId,
          event.conversationId,
          'first_response',
        );
      } else {
        await this.startMetric(
          event.tenantId,
          event.conversationId,
          'next_response',
        );
      }
      await this.projectPendingDeadline(event.tenantId, event.conversationId);
    });
  }

  @OnEvent(OmniEvents.MESSAGE_SENT, { async: true })
  async onAgentReply(event: any): Promise<void> {
    if (event.senderType && event.senderType !== 'agent') return;
    const respondedAt = new Date();
    // On an agent message `senderId` is the agent's user id (OutboundService
    // sets it from `agentId`); on a bot message it is `bot:<provider>`, which the
    // guard above has already excluded.
    const responderId = event.senderId ? String(event.senderId) : null;

    // The business fact first, independent of whether a policy is configured:
    // First Response Time has to be measurable in a tenant that has written no
    // SLA policy at all.
    await runWithTenantContext(this.cls, event.tenantId, async () => {
      await this.conversations.recordFirstResponse(
        event.conversationId,
        respondedAt,
        responderId,
      );
    });

    await this.meetOpenResponseClocks(
      event.tenantId,
      event.conversationId,
      respondedAt,
    );
    await this.projectPendingDeadline(event.tenantId, event.conversationId);
  }

  @OnEvent(OmniEvents.CONVERSATION_STATUS_CHANGED, { async: true })
  async onStatusChanged(event: any): Promise<void> {
    const status = event.newStatus ?? event.status;
    if (status === 'pending') {
      await this.pauseConversation(event.tenantId, event.conversationId);
    } else if (status === 'open') {
      await this.resumeConversation(event.tenantId, event.conversationId);
    } else if (status === 'resolved' || status === 'closed') {
      await this.completeConversation(event.tenantId, event.conversationId);
    }
    await this.projectPendingDeadline(event.tenantId, event.conversationId);
  }

  async startMetric(
    tenantId: string,
    conversationId: string,
    metric: SlaMetric,
  ): Promise<SlaClockDocument | null> {
    const policies = await this.policies.findAll(tenantId);
    const policy = policies
      .filter((item) => item.enabled && item.type === metric)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
    const target = policy?.targets?.[0];
    if (!policy || !target) return null;

    const targetMinutes = this.toMinutes(target.timeValue, target.timeUnit);
    const latest = await this.clocks
      .findOne({ tenantId, conversationId, metric })
      .sort({ cycle: -1 })
      .lean()
      .exec();
    if (latest && ['running', 'paused'].includes(latest.status)) {
      return latest as any;
    }

    // `first_response` and `resolution` are once-per-conversation, so a settled
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
      return await this.clocks.create({
        tenantId,
        conversationId,
        policyId: policy.id,
        metric,
        cycle,
        status: 'running',
        targetMinutes,
        startedAt: new Date(),
        dueAt,
        segment: target.segment ?? null,
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      return this.clocks
        .findOne({ tenantId, conversationId, metric, cycle })
        .exec();
    }
  }

  async pauseConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<number> {
    const now = new Date();
    const running = await this.clocks
      .find({ tenantId, conversationId, status: 'running' })
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

  async resumeConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<number> {
    const paused = await this.clocks
      .find({ tenantId, conversationId, status: 'paused' })
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

  async completeConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    const now = new Date();
    await this.settleClocks(
      {
        tenantId,
        conversationId,
        metric: 'resolution',
        status: { $in: ['running', 'paused'] },
      },
      now,
    );
    await this.clocks
      .updateMany(
        {
          tenantId,
          conversationId,
          metric: { $in: ['first_response', 'next_response'] },
          status: { $in: ['running', 'paused'] },
        },
        { $set: { status: 'cancelled' } },
      )
      .exec();
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async breachDueClocks(): Promise<number> {
    const candidates = await this.clocks
      .find({ status: 'running', dueAt: { $lte: new Date() } })
      .select('_id tenantId conversationId policyId metric cycle dueAt')
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

  listForConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<SlaClockDocument[]> {
    return this.clocks
      .find({ tenantId, conversationId })
      .sort({ metric: 1, cycle: -1 })
      .lean()
      .exec() as any;
  }

  // Internals

  private async startResponseAndResolutionClocks(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    await runWithTenantContext(this.cls, tenantId, async () => {
      await Promise.all([
        this.startMetric(tenantId, conversationId, 'first_response'),
        this.startMetric(tenantId, conversationId, 'resolution'),
      ]);
      await this.projectPendingDeadline(tenantId, conversationId);
    });
  }

  private async meetOpenResponseClocks(
    tenantId: string,
    conversationId: string,
    metAt: Date,
  ): Promise<void> {
    await this.settleClocks(
      {
        tenantId,
        conversationId,
        metric: { $in: ['first_response', 'next_response'] },
        status: { $in: ['running', 'paused'] },
      },
      metAt,
    );
  }

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
   * to: escalation policies, the conversation activity trail, the daily metrics
   * projection and the inbox socket all consume
   * `OmniEvents.CONVERSATION_SLA_BREACHED`.
   */
  private async announceBreach(clock: SlaClockDocument): Promise<void> {
    const tenantId = String(clock.tenantId);
    const conversationId = String(clock.conversationId);
    const breachedAt = clock.breachedAt ?? new Date();

    await runWithTenantContext(this.cls, tenantId, async () => {
      await this.conversations.projectSlaState(conversationId, {
        slaDueAt: null,
        slaDueMetric: null,
        breachedAt,
      });
      const pending = await this.pendingDeadline(tenantId, conversationId);
      await this.conversations.projectSlaState(conversationId, pending);
    });

    this.events.emit(OmniEvents.CONVERSATION_SLA_BREACHED, {
      tenantId,
      conversationId,
      clockId: String(clock._id),
      slaPolicyId: String(clock.policyId),
      metric: clock.metric,
      cycle: clock.cycle,
      dueAt: clock.dueAt,
      breachedAt,
    });
  }

  /**
   * Refresh the conversation's pending-deadline projection.
   *
   * Kept to the two fields that actually change so a deadline update never
   * resets the sticky `slaBreached` flag.
   */
  private async projectPendingDeadline(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    const pending = await this.pendingDeadline(tenantId, conversationId);
    await runWithTenantContext(this.cls, tenantId, () =>
      this.conversations.projectSlaState(conversationId, pending),
    );
  }

  /** The soonest deadline still owed on this conversation. */
  private async pendingDeadline(
    tenantId: string,
    conversationId: string,
  ): Promise<{ slaDueAt: Date | null; slaDueMetric: SlaMetric | null }> {
    const next = await this.clocks
      .findOne({ tenantId, conversationId, status: 'running' })
      .select('dueAt metric')
      .sort({ dueAt: 1 })
      .lean()
      .exec();
    return {
      slaDueAt: next?.dueAt ?? null,
      slaDueMetric: (next?.metric as SlaMetric) ?? null,
    };
  }

  private toMinutes(value: number, unit: string): number {
    if (unit === 'days') return value * 24 * 60;
    if (unit === 'hours') return value * 60;
    return value;
  }
}
