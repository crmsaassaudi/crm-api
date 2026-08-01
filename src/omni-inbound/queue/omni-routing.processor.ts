import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import { OmniPayload } from '../domain/omni-payload';
import { OMNI_ROUTING_QUEUE } from './omni-queue.constants';
import { IdempotencyService } from '../../redis/idempotency.service';
import { buildMessageDedupId } from '../domain/message-dedup-id';
import { OMNI_CONCURRENCY } from '../../queue/config/worker-concurrency';

export type OmniRoutingJobData = OmniPayload;

@Processor(OMNI_ROUTING_QUEUE, { concurrency: OMNI_CONCURRENCY.routing() })
export class OmniRoutingProcessor extends BaseTenantConsumer<OmniRoutingJobData> {
  protected readonly logger = new Logger(OmniRoutingProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    cls: ClsService,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<OmniRoutingJobData>): Promise<void> {
    const payload = job.data;

    // `buildMessageDedupId` falls back to a content fingerprint when the
    // provider gave no message id. Interpolating a possibly-empty
    // `externalMessageId` into the key instead collapsed every such message in
    // the tenant onto one key, so the first one processed suppressed all the
    // others for the lifetime of that key.
    const dedupKey = `omni:dedup:${payload.tenantId}:${buildMessageDedupId(payload)}`;

    // A claim, not a marker: it is promoted to a permanent duplicate marker
    // only after the listeners have run, so a killed worker retries instead of
    // silently dropping the message.
    const claimed = await this.idempotency.claim(
      dedupKey,
      String(job.id ?? job.name),
    );
    if (!claimed) {
      this.logger.debug(
        `[OmniRouting] Duplicate skipped: ${payload.externalMessageId} tenant=${payload.tenantId}`,
      );
      return;
    }

    this.logger.debug(
      `Routing omni message ${payload.externalMessageId} for tenant ${payload.tenantId}`,
    );

    await this.eventEmitter.emitAsync('omni.message.received', payload);
    await this.idempotency.commit(dedupKey);
  }
}
