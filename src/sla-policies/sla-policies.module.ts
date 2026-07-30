import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SlaPoliciesController } from './sla-policies.controller';
import { SlaPoliciesService } from './sla-policies.service';
import { SlaPolicyRepository } from './infrastructure/persistence/document/repositories/sla-policy.repository';
import {
  SlaPolicySchema,
  SlaPolicySchemaClass,
} from './infrastructure/persistence/document/entities/sla-policy.schema';
import { SlaMonitorService } from './sla-monitor.service';
import { SlaTriggerListener } from './sla-trigger.listener';
import { SlaCancellationListener } from './sla-cancellation.listener';
import { SlaBreachProcessor } from './queue/sla-breach.processor';
import { SlaQueueModule } from './queue/sla-queue.module';

import { OmniInboundModule } from '../omni-inbound/omni-inbound.module';
import { isWorkerRuntime } from '../config/runtime-role';
import { SlaClockSchema, SlaClockSchemaClass } from './clock/sla-clock.schema';
import { SlaClockService } from './clock/sla-clock.service';

@Module({
  imports: [
    SlaQueueModule,
    OmniInboundModule,
    MongooseModule.forFeature([
      { name: SlaPolicySchemaClass.name, schema: SlaPolicySchema },
      { name: SlaClockSchemaClass.name, schema: SlaClockSchema },
    ]),
  ],
  controllers: [SlaPoliciesController],
  providers: [
    SlaPoliciesService,
    SlaPolicyRepository,
    SlaMonitorService,
    SlaTriggerListener,
    SlaCancellationListener,
    SlaClockService,
    ...(isWorkerRuntime() ? [SlaBreachProcessor] : []),
  ],
  exports: [SlaPoliciesService, SlaMonitorService, SlaClockService],
})
export class SlaPoliciesModule {}
