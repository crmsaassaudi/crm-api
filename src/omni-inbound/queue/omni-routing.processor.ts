import { Processor } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { BaseConsumer } from '../../queue/base.consumer';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { OmniPayload } from '../domain/omni-payload';
import { OMNI_ROUTING_QUEUE } from './omni-queue.constants';

export type OmniRoutingJobData = OmniPayload;

@Processor(OMNI_ROUTING_QUEUE)
export class OmniRoutingProcessor extends BaseConsumer {
  protected readonly logger = new Logger(OmniRoutingProcessor.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {
    super();
  }

  async process(job: Job<OmniRoutingJobData>): Promise<void> {
    const payload = job.data;

    await runWithTenantContext(this.cls, payload.tenantId, async () => {
      this.logger.log(
        `Routing omni message ${payload.externalMessageId} for tenant ${payload.tenantId}`,
      );
      await this.eventEmitter.emitAsync('omni.message.received', payload);
    });
  }
}
