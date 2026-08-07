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
import {
  TicketSchema,
  TicketSchemaClass,
} from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { isWorkerRuntime } from '../config/runtime-role';
import { OmniInboundModule } from '../omni-inbound/omni-inbound.module';

@Module({
  imports: [
    EscalationQueueModule,
    // `EscalationProcessor` injects `ConversationCommandService` and this module
    // never imported the module that provides it, so the container could not
    // build it. The failure was invisible in the two deployments that matter
    // most day to day — the processor is only registered under
    // `isWorkerRuntime()`, which is false for `APP_RUNTIME=api` — and fatal in
    // all-in-one mode, which is what a developer runs and what a single-container
    // deployment runs. Bootstrap aborted before the first request.
    //
    // No cycle: OmniInboundModule does not import this module, and the app
    // module imports both.
    OmniInboundModule,
    MongooseModule.forFeature([
      {
        name: EscalationPolicySchemaClass.name,
        schema: EscalationPolicySchema,
      },
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
      { name: TicketSchemaClass.name, schema: TicketSchema },
    ]),
  ],
  controllers: [EscalationPoliciesController],
  providers: [
    EscalationPoliciesService,
    EscalationPolicyRepository,
    EscalationTriggerListener,
    ...(isWorkerRuntime() ? [EscalationProcessor] : []),
  ],
  exports: [EscalationPoliciesService],
})
export class EscalationPoliciesModule {}
