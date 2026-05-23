import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../../queue/base-tenant.consumer';
import { AssignmentService } from '../services/assignment.service';
import { OMNI_STICKY_RETRY_QUEUE } from './omni-sticky-queue.constants';

export interface StickyRetryJobData extends TenantJobData {
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
export class StickyRetryProcessor extends BaseTenantConsumer<StickyRetryJobData> {
  protected readonly logger = new Logger(StickyRetryProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    private readonly assignmentService: AssignmentService,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<StickyRetryJobData>): Promise<void> {
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
          skipSticky: true,
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
