import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { BaseConsumer } from '../../queue/base.consumer';
import { AssignmentService } from '../services/assignment.service';
import { OMNI_STICKY_RETRY_QUEUE } from './omni-sticky-queue.constants';

export interface StickyRetryJobData {
  tenantId: string;
  conversationId: string;
  /** The sticky agent who was at-capacity when originally attempted */
  stickyAgentId: string;
  /** Strategy to use for fallback (skips sticky) */
  fallbackStrategy: string;
}

/**
 * BullMQ processor that retries assignment after the sticky wait-time expires.
 *
 * When a customer's preferred (sticky) agent is at capacity, the system
 * waits for a configurable period (e.g. 3 minutes) before falling back
 * to another assignment strategy. This processor runs when that delay
 * expires and assigns the conversation via the fallback strategy.
 */
@Processor(OMNI_STICKY_RETRY_QUEUE)
export class StickyRetryProcessor extends BaseConsumer {
  protected readonly logger = new Logger(StickyRetryProcessor.name);

  constructor(private readonly assignmentService: AssignmentService) {
    super();
  }

  async process(job: Job<StickyRetryJobData>): Promise<void> {
    const { tenantId, conversationId, stickyAgentId, fallbackStrategy } =
      job.data;

    this.logger.log(
      `Sticky wait-time expired for conversation ${conversationId} ` +
        `(sticky agent: ${stickyAgentId}) — retrying with ${fallbackStrategy}`,
    );

    try {
      const assignedAgentId = await this.assignmentService.assignConversation(
        tenantId,
        conversationId,
        {
          strategy: fallbackStrategy as any,
          // Exclude sticky routing — we already tried and waited
        },
      );

      this.logger.log(
        `Sticky retry: conversation ${conversationId} assigned to ` +
          `${assignedAgentId ?? 'queue (no agents available)'}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Sticky retry failed for conversation ${conversationId}: ${error.message}`,
        error.stack,
      );
      throw error; // Re-throw so BullMQ retries
    }
  }
}
