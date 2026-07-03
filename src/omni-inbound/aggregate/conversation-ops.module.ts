import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';

import { CONV_OPS_QUEUE, CONV_OPS_DLQ } from './conversation-ops.constants';
import { ConversationCommandService } from './conversation-command.service';
import { ConversationOpsProcessor } from './conversation-ops.processor';
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
 * ConversationOpsModule — Conversation Aggregate infrastructure.
 *
 * Registers:
 * - BullMQ queues: conversation-ops + DLQ
 * - MongoDB schemas: processed_operations + outbox_events
 * - ConversationCommandService: builds and enqueues commands
 * - ConversationOpsProcessor: processes commands (worker only)
 * - OutboxPublisherService: cron poller for missed event publishes
 *
 * This module should be imported by OmniInboundModule.
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
    // Processor is always registered — API runtime uses executeInline(),
    // Worker runtime additionally processes BullMQ jobs via @Processor decorator
    ConversationOpsProcessor,
    // Outbox poller only needed in worker runtime
    ...(isWorkerRuntime() || isOmniRuntime()
      ? [OutboxPublisherService]
      : []),
  ],
  exports: [ConversationCommandService, BullModule],
})
export class ConversationOpsModule {}
