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
import { OMNI_CONCURRENCY } from '../../queue/config/worker-concurrency';

export interface StickyRetryJobData extends TenantJobData {
  conversationId: string;
  /** The preferred agent who was at capacity when the decision was deferred. */
  stickyAgentId: string;
  /**
   * Legacy field. The retry no longer picks a strategy: it re-runs the normal
   * decision with the preference disabled, so the tenant's configured
   * `fallbackStrategy` applies. Kept on the interface so jobs enqueued before
   * this change still deserialise.
   */
  fallbackStrategy?: string;
}

/**
 * Retries assignment once the preferred-agent wait window has expired.
 *
 * The retry deliberately passes neither a strategy nor a pool: the
 * conversation's channel — and therefore its support pool — is resolved from the
 * conversation itself. Passing neither previously meant the strategy ran with no
 * channel context at all, so a restricted channel's conversation could be handed
 * to an agent outside its support pool on retry.
 */
@Processor(OMNI_STICKY_RETRY_QUEUE, {
  concurrency: OMNI_CONCURRENCY.maintenance(),
})
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
    const { tenantId, conversationId, stickyAgentId } = job.data;

    this.logger.log(
      `Preferred-agent wait expired for conversation ${conversationId} ` +
        `(agent ${stickyAgentId}) — re-running assignment without the preference`,
    );

    try {
      const assignedAgentId = await this.assignmentService.assignConversation(
        tenantId,
        conversationId,
        {
          skipSticky: true,
          source: 'retry',
        },
      );

      this.logger.log(
        `Preferred-agent retry: conversation ${conversationId} → ` +
          `${assignedAgentId ?? 'queue (nobody available)'}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Preferred-agent retry failed for conversation ${conversationId}: ${error.message}`,
        error.stack,
      );
      throw error; // let BullMQ retry
    }
  }
}
