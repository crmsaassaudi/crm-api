import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskRepository } from './infrastructure/persistence/document/repositories/task.repository';
import { RecurringTaskService } from './recurring-task.service';
import {
  TaskSchema,
  TaskSchemaClass,
} from './infrastructure/persistence/document/entities/task.schema';
import {
  TaskStatusSchema,
  TaskStatusSchemaClass,
} from '../task-settings/entities/task-status.schema';
import { AutomationOutboxModule } from '../automation-rules/events/automation-outbox.module';
import { isWorkerRuntime } from '../config/runtime-role';
import { TaskPurgeService } from './task-purge.service';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { TASK_EXPORT_QUEUE } from './tasks.constants';
import { TaskExportProcessor } from './export/task-export.processor';

const workerProviders = isWorkerRuntime()
  ? [
      // Retention purge: the only path that hard-deletes, plus the cascade that keeps
      // related records from being orphaned by it. Worker-gated like every other cron —
      // an unconditional provider schedules it in every API replica too and makes the
      // Redis lock load-bearing for correctness rather than a safety net.
      TaskPurgeService,
      TaskExportProcessor,
    ]
  : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TaskSchemaClass.name, schema: TaskSchema },
      { name: TaskStatusSchemaClass.name, schema: TaskStatusSchema },
    ]),
    AutomationOutboxModule,
    CustomFieldsModule,
    BullModule.registerQueue({
      name: TASK_EXPORT_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
    BullBoardModule.forFeature({
      name: TASK_EXPORT_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [TasksController],
  providers: [
    TasksService,
    TaskRepository,
    RecurringTaskService,
    ...workerProviders,
  ],
  exports: [TasksService],
})
export class TasksModule {}
