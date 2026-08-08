import { TenantJobData } from '../../queue/base-tenant.consumer';

/** Materialise the audience, then fan out send batches. One job per run. */
export interface CampaignDispatchJobData extends TenantJobData {
  campaignId: string;
}

/**
 * Send to a fixed list of recipients.
 *
 * The ids are carried in the payload rather than the worker querying for "the
 * next N pending rows": two workers running that query concurrently would claim
 * overlapping sets, and the batch would then be neither resumable nor countable.
 */
export interface CampaignSendJobData extends TenantJobData {
  campaignId: string;
  recipientIds: string[];
}
