import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';

import { CONV_OPS_QUEUE, CONV_OPS_DLQ } from './conversation-ops.constants';
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
import { isWorkerRuntime, isOmniRuntime } from '../../config/runtime-role';

/**
 * ConversationOpsModule — Shared BullMQ queue infrastructure + Mongoose schemas.
 *
 * Logic services (ConversationCommandService, ConversationOpsProcessor) are
 * registered in OmniInboundModule to avoid complex circular dependency cycles
 * and ensure they have access to all necessary repositories.
 */
@Module({
  imports: [
    RedisModule,
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
    ...(isWorkerRuntime() || isOmniRuntime() ? [OutboxPublisherService] : []),
  ],
  // Export BullModule and MongooseModule so they can be used by services in OmniInboundModule
  exports: [BullModule, MongooseModule],
})
export class ConversationOpsModule {}
