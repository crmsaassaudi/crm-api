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
import {
  OmniConversationSchema,
  OmniConversationSchemaClass,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

@Module({
  imports: [
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
  ],
  exports: [SlaPoliciesService],
})
export class SlaPoliciesModule {}
