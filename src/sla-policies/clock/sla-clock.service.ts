import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { BusinessHoursService } from '../../omni-inbound/services/business-hours.service';
import { ClsService } from 'nestjs-cls';
import { SlaPolicyRepository } from '../infrastructure/persistence/document/repositories/sla-policy.repository';
import { SlaClockDocument, SlaClockSchemaClass } from './sla-clock.schema';

type Metric = 'first_response' | 'next_response' | 'resolution';

@Injectable()
export class SlaClockService {
  constructor(
    @InjectModel(SlaClockSchemaClass.name)
    private readonly clocks: Model<SlaClockDocument>,
    private readonly policies: SlaPolicyRepository,
    private readonly businessHours: BusinessHoursService,
    private readonly events: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  @OnEvent('omni.conversation.created', { async: true })
  async onConversationCreated(event: any): Promise<void> {
    await runWithTenantContext(this.cls, event.tenantId, async () => {
      await Promise.all([
        this.startMetric(
          event.tenantId,
          event.conversationId,
          'first_response',
        ),
        this.startMetric(event.tenantId, event.conversationId, 'resolution'),
      ]);
    });
  }

  @OnEvent('omni.message.persisted', { async: true })
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
        return;
      }
      await this.startMetric(
        event.tenantId,
        event.conversationId,
        'next_response',
      );
    });
  }

  @OnEvent('omni.message.sent', { async: true })
  async onAgentReply(event: any): Promise<void> {
    if (event.senderType && event.senderType !== 'agent') return;
    await this.meetOpenResponseClocks(
      event.tenantId,
      event.conversationId,
      new Date(),
    );
  }

  @OnEvent('omni.conversation.status_changed', { async: true })
  async onStatusChanged(event: any): Promise<void> {
    const status = event.newStatus ?? event.status;
    if (status === 'pending') {
      await this.pauseConversation(event.tenantId, event.conversationId);
    } else if (status === 'open') {
      await this.resumeConversation(event.tenantId, event.conversationId);
    } else if (status === 'resolved' || status === 'closed') {
      await this.completeConversation(event.tenantId, event.conversationId);
    }
  }

  async startMetric(
    tenantId: string,
    conversationId: string,
    metric: Metric,
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
    if (metric !== 'next_response' && latest) return latest as any;

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
      .limit(500)
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();
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
      this.emitBreach(clock);
      breached++;
    }
    return breached;
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
      if (updated && breached) this.emitBreach(updated);
    }
  }

  private emitBreach(clock: SlaClockDocument): void {
    this.events.emit('omni.sla.clock_breached', {
      tenantId: String(clock.tenantId),
      conversationId: String(clock.conversationId),
      clockId: String(clock._id),
      policyId: String(clock.policyId),
      metric: clock.metric,
      cycle: clock.cycle,
      dueAt: clock.dueAt,
    });
  }

  private toMinutes(value: number, unit: string): number {
    if (unit === 'days') return value * 24 * 60;
    if (unit === 'hours') return value * 60;
    return value;
  }
}
