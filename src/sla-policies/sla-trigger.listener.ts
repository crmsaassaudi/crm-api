import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SlaPoliciesService } from './sla-policies.service';
import { SlaMonitorService } from './sla-monitor.service';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

/**
 * SlaTriggerListener — listens to `omni.conversation.created` events
 * and computes the SLA deadline based on the tenant's SLA policies.
 *
 * The deadline is written to the conversation document AND a BullMQ
 * delayed job is scheduled to fire at exactly the deadline. If the
 * agent responds before the deadline, SlaCancellationListener removes
 * the job — zero DB polling, zero wasted work.
 */
@Injectable()
export class SlaTriggerListener {
  private readonly logger = new Logger(SlaTriggerListener.name);

  constructor(
    private readonly slaPoliciesService: SlaPoliciesService,
    private readonly slaMonitorService: SlaMonitorService,
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationDocument>,
  ) {}

  /**
   * When a new conversation is created, compute and set the SLA deadline.
   * Looks for an enabled `first_response` SLA policy for the tenant.
   */
  @OnEvent('omni.conversation.created')
  async handleConversationCreated(event: {
    tenantId: string;
    conversationId: string;
  }): Promise<void> {
    try {
      const policies = await this.slaPoliciesService.findAll();
      // Pick the first enabled first_response policy (highest priority)
      const firstResponsePolicy = policies
        .filter((p) => p.enabled && p.type === 'first_response')
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];

      if (!firstResponsePolicy || !firstResponsePolicy.targets?.length) {
        return; // No applicable SLA policy
      }

      // Use the first target (default segment)
      const target = firstResponsePolicy.targets[0];
      const deadlineMs = this.computeDeadlineMs(
        target.timeValue,
        target.timeUnit,
      );
      const slaDeadline = new Date(Date.now() + deadlineMs);

      // ── Step 1: Write deadline to conversation document ─────────
      await this.conversationModel.updateOne(
        { _id: event.conversationId },
        {
          $set: {
            slaPolicyId: firstResponsePolicy.id,
            slaDeadline,
            slaBreached: false,
          },
        },
      );

      // ── Step 2: Schedule BullMQ delayed job for breach check ────
      await this.slaMonitorService.scheduleSlaBreachCheck(
        event.tenantId,
        event.conversationId,
        firstResponsePolicy.id,
        deadlineMs,
      );

      this.logger.log(
        `Set SLA deadline for conversation ${event.conversationId}: ` +
          `${slaDeadline.toISOString()} (policy: ${firstResponsePolicy.name})`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to set SLA for conversation ${event.conversationId}: ${err.message}`,
      );
    }
  }

  private computeDeadlineMs(timeValue: number, timeUnit: string): number {
    switch (timeUnit) {
      case 'minutes':
        return timeValue * 60 * 1000;
      case 'hours':
        return timeValue * 60 * 60 * 1000;
      case 'days':
        return timeValue * 24 * 60 * 60 * 1000;
      default:
        return timeValue * 60 * 1000; // default to minutes
    }
  }
}
