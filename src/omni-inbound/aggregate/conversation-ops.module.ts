import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';

import { CONV_OPS_QUEUE, CONV_OPS_DLQ } from './conversation-ops.constants';
import { ConversationCommandService } from './conversation-command.service';
import { OutboxPublisherService } from './outbox-publisher.service';

import {
  ProcessedOperationSchemaClass,
  ProcessedOperationSchema,
} from '../infrastructure/persistence/document/entities/processed-operation.schema';
import {
  OutboxEventSchemaClass,
  OutboxEventSchema,
} from '../infrastructure/persistence/document/entities/outbox-event.schema';

import { RedisModule } from '../../redis/redis.module';
import { OmniOutboundModule } from '../../omni-outbound/omni-outbound.module';
import { isWorkerRuntime, isOmniRuntime } from '../../config/runtime-role';

/**
 * ConversationOpsModule — BullMQ queue infrastructure + command service.
 *
 * Intentionally does NOT register ConversationOpsProcessor here.
 * The processor depends on ConversationRepository, MessageRepository,
 * InboundOrchestrationService, AgentPresenceService, AssignmentService —
 * all of which live in OmniInboundModule.
 *
 * Registering the processor in OmniInboundModule (which imports this module)
 * avoids the circular dependency:
 *   ConversationOpsModule → OmniInboundModule → ConversationOpsModule
 *
 * Registers:
 * - BullMQ queues: conversation-ops + DLQ
 * - MongoDB schemas: processed_operations + outbox_events
 * - ConversationCommandService: builds and enqueues typed commands
 * - OutboxPublisherService: cron poller for missed event publishes
 */
@Module({
  imports: [
    RedisModule,
    forwardRef(() => OmniOutboundModule),
    ScheduleModule.forRoot(),
    BullModule.registerQueue(
      {
        name: CONV_OPS_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: false,
        },
      },
      {
        name: CONV_OPS_DLQ,
        defaultJobOptions: {
          removeOnComplete: false,
          removeOnFail: false,
        },
      },
    ),
    MongooseModule.forFeature([
      {
        name: ProcessedOperationSchemaClass.name,
        schema: ProcessedOperationSchema,
      },
      {
        name: OutboxEventSchemaClass.name,
        schema: OutboxEventSchema,
      },
    ]),
  ],
  providers: [
    ConversationCommandService,
    ...(isWorkerRuntime() || isOmniRuntime() ? [OutboxPublisherService] : []),
  ],
  // Export MongooseModule so OmniInboundModule can access ProcessedOperation
  // and OutboxEvent models needed by ConversationOpsProcessor
  exports: [ConversationCommandService, BullModule, MongooseModule],
})
export class ConversationOpsModule {}
