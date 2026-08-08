import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import { CampaignRunnerService } from '../campaign-runner.service';
import { CAMPAIGN_DISPATCH_QUEUE } from '../campaigns.constants';
import { CampaignDispatchJobData } from './campaign-jobs';

/**
 * Low concurrency on purpose: a dispatch walks an entire audience with an open
 * cursor, so several at once mostly compete for the same database. The sends
 * themselves are where parallelism pays, and they have their own queue.
 */
@Processor(CAMPAIGN_DISPATCH_QUEUE, {
  concurrency: parseInt(process.env.CAMPAIGN_DISPATCH_CONCURRENCY ?? '2', 10),
})
export class CampaignDispatchProcessor extends BaseTenantConsumer<CampaignDispatchJobData> {
  protected readonly logger = new Logger(CampaignDispatchProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    cls: ClsService,
    private readonly runner: CampaignRunnerService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<CampaignDispatchJobData>): Promise<void> {
    // `scope` is forwarded, not just consumed: the send jobs this dispatch
    // creates must narrow reads exactly as the launcher's own request would.
    await this.runner.dispatch(
      job.data.campaignId,
      job.data.tenantId,
      job.data.scope,
    );
  }
}
