import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TENANT_PROVISIONING_QUEUE } from '../constants/queue.constants';
import { TenantProvisioningJobData } from '../interfaces/tenant-provisioning.interfaces';

/**
 * Enqueues tenant provisioning jobs into BullMQ.
 *
 * Used by:
 * - PLG flow: POST /onboarding/complete
 * - SLG flow: POST /internal/tenants/provision
 */
@Injectable()
export class TenantProvisioningProducer {
  private readonly logger = new Logger(TenantProvisioningProducer.name);

  constructor(
    @InjectQueue(TENANT_PROVISIONING_QUEUE)
    private readonly provisioningQueue: Queue,
  ) {}

  /**
   * Enqueue a tenant provisioning job.
   *
   * @param data  The provisioning job payload
   * @returns     The BullMQ Job ID
   */
  async enqueue(data: TenantProvisioningJobData): Promise<string> {
    const job = await this.provisioningQueue.add('provision-tenant', data, {
      jobId: data.provisioningId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 86_400 }, // keep 24h for auditing
      removeOnFail: { age: 604_800 }, // keep 7 days for debugging
    });

    this.logger.log(
      `[${data.source}] Enqueued provisioning job: ${job.id} for "${data.companyName}" (alias: ${data.alias})`,
    );

    return job.id!;
  }

  /**
   * Retry a failed provisioning job by ID.
   *
   * @param provisioningId  The failed job's provisioning ID
   * @returns               Boolean representing if the retry was successfully enqueued
   */
  async retry(provisioningId: string): Promise<boolean> {
    const job = await this.provisioningQueue.getJob(provisioningId);
    if (job) {
      await job.retry();
      this.logger.log(`Retried enqueued job: ${provisioningId}`);
      return true;
    }
    return false;
  }
}
