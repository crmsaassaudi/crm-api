import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseConsumer } from '../../queue/base.consumer';
import { SLA_BREACH_QUEUE } from './sla-queue.constants';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

export interface SlaBreachJobData {
  tenantId: string;
  conversationId: string;
  slaPolicyId: string;
}

/**
 * BullMQ processor that handles per-conversation SLA breach-check delayed jobs.
 *
 * Replaces the old `@Cron(EVERY_MINUTE)` DB scan approach. Each conversation
 * gets its own delayed job scheduled for exactly the SLA deadline duration.
 *
 * When the job fires:
 *   1. Verify conversation is still open/pending and not already breached
 *   2. Mark `slaBreached = true` on the conversation document
 *   3. Emit `sla.breached` event for escalation-policies to react
 *
 * If the agent responded before the deadline, the job will have been removed
 * by SlaCancellationListener — so this processor never runs. Zero wasted work.
 */
@Processor(SLA_BREACH_QUEUE)
export class SlaBreachProcessor extends BaseConsumer {
  protected readonly logger = new Logger(SlaBreachProcessor.name);

  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<SlaBreachJobData>): Promise<void> {
    const { tenantId, conversationId, slaPolicyId } = job.data;
    const now = new Date();

    this.logger.debug(
      `Processing SLA breach check for conversation ${conversationId}`,
    );

    // ── Step 1: Verify conversation is still eligible for breach ──
    const conversation = await this.conversationModel
      .findOne({
        _id: conversationId,
        tenantId,
        status: { $in: ['open', 'pending'] },
        slaBreached: false,
      })
      .lean()
      .exec();

    if (!conversation) {
      this.logger.debug(
        `Conversation ${conversationId} is no longer eligible for SLA breach ` +
          `(resolved, closed, or already breached) — skipping`,
      );
      return;
    }

    // ── Step 2: Mark SLA as breached ──────────────────────────────
    await this.conversationModel.updateOne(
      { _id: conversationId },
      { $set: { slaBreached: true } },
    );

    // ── Step 3: Emit event for escalation-policies module ────────
    this.eventEmitter.emit('sla.breached', {
      tenantId,
      conversationId,
      channelType: conversation.channelType,
      assignedAgentId: conversation.assignedAgentId,
      slaDeadline: conversation.slaDeadline,
      slaPolicyId,
      breachedAt: now,
    });

    this.logger.warn(
      `SLA breached for conversation ${conversationId} ` +
        `(deadline: ${conversation.slaDeadline?.toISOString()}, ` +
        `policy: ${slaPolicyId})`,
    );
  }
}
