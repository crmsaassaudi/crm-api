import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CAMPAIGN_DISPATCH_JOB,
  CAMPAIGN_DISPATCH_QUEUE,
  CAMPAIGN_SEND_JOB,
  CAMPAIGN_SEND_QUEUE,
} from '../campaigns.constants';
import { CampaignDispatchJobData, CampaignSendJobData } from './campaign-jobs';

@Injectable()
export class CampaignProducer {
  constructor(
    @InjectQueue(CAMPAIGN_DISPATCH_QUEUE) private readonly dispatchQueue: Queue,
    @InjectQueue(CAMPAIGN_SEND_QUEUE) private readonly sendQueue: Queue,
  ) {}

  /**
   * No `jobId`, deliberately.
   *
   * A stable id would deduplicate — and would also block the second dispatch a
   * resume legitimately needs, since BullMQ keeps a completed job's id reserved.
   * Two concurrent dispatches are harmless instead: materialisation upserts on
   * `(campaignId, contactId)` and every send claims its recipient with a
   * compare-and-set, so the worst case is a wasted queue round trip.
   */
  async enqueueDispatch(
    campaignId: string,
    tenantId: string,
    scope?: Record<string, unknown>,
  ): Promise<void> {
    const data: CampaignDispatchJobData = { campaignId, tenantId, scope };
    await this.dispatchQueue.add(CAMPAIGN_DISPATCH_JOB, data);
  }

  async enqueueSendBatch(
    data: CampaignSendJobData,
    delayMs = 0,
  ): Promise<void> {
    await this.sendQueue.add(CAMPAIGN_SEND_JOB, data, {
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    });
  }
}
