import { Processor } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { BaseConsumer } from '../../queue/base.consumer';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { OmniPayload } from '../domain/omni-payload';
import { OMNI_ROUTING_QUEUE } from './omni-queue.constants';
import { RedisService } from '../../redis/redis.service';

export type OmniRoutingJobData = OmniPayload;

/** 24-hour window to deduplicate retried BullMQ jobs by externalMessageId. */
const OMNI_DEDUP_TTL_SECONDS = 86_400;

@Processor(OMNI_ROUTING_QUEUE)
export class OmniRoutingProcessor extends BaseConsumer {
  protected readonly logger = new Logger(OmniRoutingProcessor.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
    private readonly redisService: RedisService,
  ) {
    super();
  }

  async process(job: Job<OmniRoutingJobData>): Promise<void> {
    const payload = job.data;

    await runWithTenantContext(this.cls, payload.tenantId, async () => {
      const dedupKey = `omni:dedup:${payload.tenantId}:${payload.externalMessageId}`;
      const client = this.redisService.getClient();
      const acquired = await client.set(
        dedupKey,
        '1',
        'NX',
        'EX',
        OMNI_DEDUP_TTL_SECONDS,
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
      await this.eventEmitter.emitAsync('omni.message.received', payload);
    });
  }
}
