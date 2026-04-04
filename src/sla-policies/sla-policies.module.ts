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
import {
  OmniConversationSchema,
  OmniConversationSchemaClass,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

@Module({
  imports: [
    SlaQueueModule,
    MongooseModule.forFeature([
      { name: SlaPolicySchemaClass.name, schema: SlaPolicySchema },
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
    ]),
  ],
  controllers: [SlaPoliciesController],
  providers: [
    SlaPoliciesService,
    SlaPolicyRepository,
    SlaMonitorService,
    SlaTriggerListener,
    SlaCancellationListener,
    SlaBreachProcessor,
  ],
  exports: [SlaPoliciesService, SlaMonitorService],
})
export class SlaPoliciesModule {}
