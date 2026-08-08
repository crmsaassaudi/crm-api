import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import { CampaignRunnerService } from '../campaign-runner.service';
import { CAMPAIGN_SEND_QUEUE } from '../campaigns.constants';
import { CampaignSendJobData } from './campaign-jobs';

/**
 * Where a campaign's throughput actually comes from.
 *
 * Each job holds an open provider session for its batch, so concurrency here is
 * concurrency at the provider — raise it only as far as the slowest provider a
 * tenant uses will tolerate. Failures are recorded per recipient rather than
 * thrown, so this job retries only on infrastructure faults, and a retry is safe
 * because every recipient is claimed with a compare-and-set.
 */
@Processor(CAMPAIGN_SEND_QUEUE, {
  concurrency: parseInt(process.env.CAMPAIGN_SEND_CONCURRENCY ?? '5', 10),
})
export class CampaignSendProcessor extends BaseTenantConsumer<CampaignSendJobData> {
  protected readonly logger = new Logger(CampaignSendProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    cls: ClsService,
    private readonly runner: CampaignRunnerService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<CampaignSendJobData>): Promise<void> {
    await this.runner.sendBatch(
      job.data.campaignId,
      job.data.recipientIds,
      job.data.tenantId,
      job.data.scope,
    );
  }
}
