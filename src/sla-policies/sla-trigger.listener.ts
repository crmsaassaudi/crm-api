import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SlaPoliciesService } from './sla-policies.service';
import { SlaMonitorService } from './sla-monitor.service';
import { BusinessHoursService } from '../omni-inbound/services/business-hours.service';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

/**
 * SlaTriggerListener — listens to `omni.conversation.created` events
 * and applies SLA policies for both First Response Time (FRT) and
 * Resolution Time.
 *
 * For each applicable policy type:
 *   1. Compute the deadline using BusinessHoursService (skips off-hours & holidays)
 *   2. Write the deadline to the conversation document
 *   3. Schedule a BullMQ delayed job to fire at exactly that deadline
 */
@Injectable()
export class SlaTriggerListener {
  private readonly logger = new Logger(SlaTriggerListener.name);

  constructor(
    private readonly slaPoliciesService: SlaPoliciesService,
    private readonly slaMonitorService: SlaMonitorService,
    private readonly businessHoursService: BusinessHoursService,
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationDocument>,
  ) {}

  /**
   * When a new conversation is created, find and apply SLA policies
   * for both first_response and resolution types.
   */
  @OnEvent('omni.conversation.created')
  async handleConversationCreated(event: {
    tenantId: string;
    conversationId: string;
  }): Promise<void> {
    try {
      const policies = await this.slaPoliciesService.findAll();
      const enabledPolicies = policies.filter((p) => p.enabled);

      // ── First Response Time (FRT) ──────────────────────────────
      const frtPolicy = enabledPolicies
        .filter((p) => p.type === 'first_response')
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];

      // ── Resolution Time ────────────────────────────────────────
      const resolutionPolicy = enabledPolicies
        .filter((p) => p.type === 'resolution')
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];

      const updatePayload: Record<string, any> = {};

      // ── Schedule FRT ───────────────────────────────────────────
      if (frtPolicy && frtPolicy.targets?.length) {
        const target = frtPolicy.targets[0];
        const durationMinutes = this.toMinutes(
          target.timeValue,
          target.timeUnit,
        );

        const frtDeadline =
          await this.businessHoursService.calculateSlaDeadline(
            event.tenantId,
            durationMinutes,
          );
        const delayMs = frtDeadline.getTime() - Date.now();

        updatePayload.frtPolicyId = frtPolicy.id;
        updatePayload.frtDeadline = frtDeadline;
        updatePayload.frtBreached = false;

        await this.slaMonitorService.scheduleSlaBreachCheck(
          event.tenantId,
          event.conversationId,
          frtPolicy.id,
          Math.max(delayMs, 0),
          'frt',
        );

        this.logger.log(
          `Set FRT deadline for conversation ${event.conversationId}: ` +
            `${frtDeadline.toISOString()} (policy: ${frtPolicy.name})`,
        );
      }

      // ── Schedule Resolution ────────────────────────────────────
      if (resolutionPolicy && resolutionPolicy.targets?.length) {
        const target = resolutionPolicy.targets[0];
        const durationMinutes = this.toMinutes(
          target.timeValue,
          target.timeUnit,
        );

        const resolutionDeadline =
          await this.businessHoursService.calculateSlaDeadline(
            event.tenantId,
            durationMinutes,
          );
        const delayMs = resolutionDeadline.getTime() - Date.now();

        updatePayload.resolutionPolicyId = resolutionPolicy.id;
        updatePayload.resolutionDeadline = resolutionDeadline;
        updatePayload.resolutionBreached = false;

        await this.slaMonitorService.scheduleSlaBreachCheck(
          event.tenantId,
          event.conversationId,
          resolutionPolicy.id,
          Math.max(delayMs, 0),
          'resolution',
        );

        this.logger.log(
          `Set Resolution deadline for conversation ${event.conversationId}: ` +
            `${resolutionDeadline.toISOString()} (policy: ${resolutionPolicy.name})`,
        );
      }

      // ── Write all deadlines to conversation document ───────────
      if (Object.keys(updatePayload).length > 0) {
        await this.conversationModel.updateOne(
          { _id: event.conversationId },
          { $set: updatePayload },
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to set SLA for conversation ${event.conversationId}: ${err.message}`,
      );
    }
  }

  private toMinutes(timeValue: number, timeUnit: string): number {
    switch (timeUnit) {
      case 'minutes':
        return timeValue;
      case 'hours':
        return timeValue * 60;
      case 'days':
        return timeValue * 24 * 60;
      default:
        return timeValue; // default to minutes
    }
  }
}
