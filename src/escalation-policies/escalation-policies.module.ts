import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EscalationPoliciesController } from './escalation-policies.controller';
import { EscalationPoliciesService } from './escalation-policies.service';
import { EscalationPolicyRepository } from './infrastructure/persistence/document/repositories/escalation-policy.repository';
import {
  EscalationPolicySchema,
  EscalationPolicySchemaClass,
} from './infrastructure/persistence/document/entities/escalation-policy.schema';
import { EscalationQueueModule } from './queue/escalation-queue.module';
import { EscalationProcessor } from './queue/escalation.processor';
import { EscalationTriggerListener } from './escalation-trigger.listener';
import {
  OmniConversationSchema,
  OmniConversationSchemaClass,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

@Module({
  imports: [
    EscalationQueueModule,
    MongooseModule.forFeature([
      {
        name: EscalationPolicySchemaClass.name,
        schema: EscalationPolicySchema,
      },
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
    ]),
  ],
  controllers: [EscalationPoliciesController],
  providers: [
    EscalationPoliciesService,
    EscalationPolicyRepository,
    EscalationProcessor,
    EscalationTriggerListener,
  ],
  exports: [EscalationPoliciesService],
})
export class EscalationPoliciesModule {}
