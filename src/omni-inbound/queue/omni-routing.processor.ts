import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../../queue/base-tenant.consumer';
import { OmniPayload } from '../domain/omni-payload';
import { OMNI_ROUTING_QUEUE } from './omni-queue.constants';
import { RedisService } from '../../redis/redis.service';

export type OmniRoutingJobData = OmniPayload;

/** 24-hour window to deduplicate retried BullMQ jobs by externalMessageId. */
const OMNI_DEDUP_TTL_SECONDS = 86_400;

@Processor(OMNI_ROUTING_QUEUE)
export class OmniRoutingProcessor extends BaseTenantConsumer<OmniRoutingJobData> {
  protected readonly logger = new Logger(OmniRoutingProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    cls: ClsService,
    private readonly redisService: RedisService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<OmniRoutingJobData>): Promise<void> {
    const payload = job.data;

    const dedupKey = `omni:dedup:${payload.tenantId}:${payload.externalMessageId}`;
    const client = this.redisService.getClient();
    const acquired = await client.set(
      dedupKey,
      '1',
      'EX',
      OMNI_DEDUP_TTL_SECONDS,
      'NX',
    );

    if (!acquired) {
      this.logger.log(
        `[OmniRouting] Duplicate skipped: externalMessageId=${payload.externalMessageId} tenant=${payload.tenantId}`,
      );
      return;
    }

    this.logger.log(
      `Routing omni message ${payload.externalMessageId} for tenant ${payload.tenantId}`,
    );

    // CRIT-07: Roll back the dedup key on failure so BullMQ retries can
    // re-process the message. Without this, a transient downstream failure
    // permanently suppresses the message for the 24h TTL window.
    try {
      await this.eventEmitter.emitAsync('omni.message.received', payload);
    } catch (error) {
      await client.del(dedupKey).catch(() => undefined);
      throw error;
    }
  }
}
