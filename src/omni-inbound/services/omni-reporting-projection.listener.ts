import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OmniEvents } from '../domain/omni-events';
import { SlaEvents } from '../../sla-policies/clock/sla-events';
import type { SlaBreachedEvent } from '../../sla-policies/clock/sla-events';
import type {
  ConversationAssignedEvent,
  ConversationCreatedEvent,
  ConversationReopenedEvent,
  ConversationStatusChangedEvent,
  MessagePersistedEvent,
  MessageSentEvent,
} from '../domain/omni-events';
import {
  OmniDailyMetricsDocument,
  OmniDailyMetricsSchemaClass,
} from '../infrastructure/persistence/document/entities/omni-daily-metrics.schema';

type MetricIncrement = Partial<
  Record<
    | 'createdCount'
    | 'reopenedCount'
    | 'resolvedCount'
    | 'closedCount'
    | 'assignedCount'
    | 'inboundMessageCount'
    | 'outboundMessageCount'
    | 'slaBreachedCount',
    number
  >
>;

@Injectable()
export class OmniReportingProjectionListener {
  private readonly logger = new Logger(OmniReportingProjectionListener.name);

  constructor(
    @InjectModel(OmniDailyMetricsSchemaClass.name)
    private readonly dailyMetrics: Model<OmniDailyMetricsDocument>,
  ) {}

  @OnEvent(OmniEvents.CONVERSATION_CREATED, { async: true })
  async onConversationCreated(event: ConversationCreatedEvent & any) {
    await this.increment(event, { createdCount: 1 });
  }

  @OnEvent(OmniEvents.CONVERSATION_REOPENED, { async: true })
  async onConversationReopened(event: ConversationReopenedEvent & any) {
    await this.increment(event, { reopenedCount: 1 });
  }

  @OnEvent(OmniEvents.CONVERSATION_STATUS_CHANGED, { async: true })
  async onStatusChanged(event: ConversationStatusChangedEvent & any) {
    const status = event.newStatus ?? event.status;
    if (status === 'resolved') {
      await this.increment(event, { resolvedCount: 1 });
    }
    if (status === 'closed') {
      await this.increment(event, { closedCount: 1 });
    }
  }

  @OnEvent(OmniEvents.CONVERSATION_ASSIGNED, { async: true })
  async onConversationAssigned(event: ConversationAssignedEvent & any) {
    if (!event.agentId) return;
    await this.increment(event, { assignedCount: 1 });
  }

  @OnEvent(OmniEvents.MESSAGE_PERSISTED, { async: true })
  async onMessagePersisted(event: MessagePersistedEvent & any) {
    await this.increment(event, { inboundMessageCount: 1 });
  }

  @OnEvent(OmniEvents.MESSAGE_SENT, { async: true })
  async onMessageSent(event: MessageSentEvent & any) {
    await this.increment(event, { outboundMessageCount: 1 });
  }

  /** Conversation breaches only — the ticket report counts its own. */
  @OnEvent(SlaEvents.BREACHED, { async: true })
  async onSlaBreached(event: SlaBreachedEvent & Record<string, any>) {
    if (event.subjectType !== 'conversation') return;
    await this.increment(
      { ...event, conversationId: event.subjectId },
      { slaBreachedCount: 1 },
    );
  }

  private async increment(event: any, inc: MetricIncrement): Promise<void> {
    try {
      const tenantId = event.tenantId;
      if (!tenantId) return;
      const at = this.eventDate(event);
      const channelType = String(event.channelType ?? 'unknown').toLowerCase();
      const inboxId = event.inboxId ?? event.conversation?.inboxId ?? null;

      await this.dailyMetrics
        .findOneAndUpdate(
          {
            tenantId,
            day: this.utcDay(at),
            channelType,
            inboxId,
          },
          {
            $setOnInsert: {
              tenantId,
              day: this.utcDay(at),
              channelType,
              inboxId,
            },
            $inc: inc,
          },
          { upsert: true, new: false },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Failed to update omni daily metrics: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private eventDate(event: any): Date {
    const raw = event.timestamp ?? event.createdAt ?? event.changedAt;
    const parsed = raw ? new Date(raw) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private utcDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }
}
