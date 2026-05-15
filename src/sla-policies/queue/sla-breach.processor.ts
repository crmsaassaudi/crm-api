import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseConsumer } from '../../queue/base.consumer';
import { SLA_BREACH_QUEUE } from './sla-queue.constants';
import { ConversationRepository } from '../../omni-inbound/repositories/conversation.repository';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';

export type SlaBreachType = 'frt' | 'resolution';

export interface SlaBreachJobData {
  tenantId: string;
  conversationId: string;
  slaPolicyId: string;
  /** Which SLA type this job monitors */
  breachType: SlaBreachType;
}

/**
 * BullMQ processor that handles per-conversation SLA breach-check delayed jobs.
 *
 * Supports two independent SLA types:
 *   - FRT (First Response Time): breach if agent doesn't reply before deadline
 *   - Resolution: breach if conversation isn't resolved before deadline
 *
 * Each type has its own delayed job and can be cancelled independently:
 *   - Agent replies → cancel FRT job
 *   - Conversation resolved → cancel Resolution job (and FRT if still pending)
 */
@Processor(SLA_BREACH_QUEUE)
export class SlaBreachProcessor extends BaseConsumer {
  protected readonly logger = new Logger(SlaBreachProcessor.name);

  constructor(
    private readonly conversationRepository: ConversationRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {
    super();
  }

  async process(job: Job<SlaBreachJobData>): Promise<void> {
    const { tenantId, conversationId, slaPolicyId, breachType } = job.data;
    const now = new Date();

    return runWithTenantContext(this.cls, tenantId, async () => {
      this.logger.debug(
        `Processing SLA breach check [${breachType}] for conversation ${conversationId}`,
      );

      // ── Build query based on breach type ──────────────────────────
      const breachedField =
        breachType === 'frt' ? 'frtBreached' : 'resolutionBreached';

      const conversation = await this.conversationRepository.findByIdForSla(
        conversationId,
        tenantId,
        breachedField,
      );

      if (!conversation) {
        this.logger.debug(
          `Conversation ${conversationId} not eligible for ${breachType} breach — skipping`,
        );
        return;
      }

      // ── Mark breach ──────────────────────────────────────────────
      await this.conversationRepository.markSlaBreached(
        conversationId,
        breachedField,
      );

      // ── Emit event for escalation-policies ───────────────────────
      const deadlineField =
        breachType === 'frt' ? 'frtDeadline' : 'resolutionDeadline';

      this.eventEmitter.emit('sla.breached', {
        tenantId,
        conversationId,
        channelType: conversation.channelType,
        assignedAgentId: conversation.assignedAgentId,
        slaDeadline: conversation[deadlineField],
        slaPolicyId,
        breachType,
        breachedAt: now,
      });

      this.logger.warn(
        `SLA [${breachType}] breached for conversation ${conversationId} ` +
          `(policy: ${slaPolicyId})`,
      );
    });
  }
}
