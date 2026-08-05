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
import {
  TaskCategorySchema,
  TaskCategorySchemaClass,
} from '../task-settings/entities/task-category.schema';
import {
  TaskSourceSchema,
  TaskSourceSchemaClass,
} from '../task-settings/entities/task-source.schema';
import {
  UserSchema,
  UserSchemaClass,
} from '../users/infrastructure/persistence/document/entities/user.schema';
import { TaskReferenceValidator } from './task-reference.validator';
import { TaskReminderService } from './task-reminder.service';
import { AutomationOutboxModule } from '../automation-rules/events/automation-outbox.module';
import { isWorkerRuntime } from '../config/runtime-role';
import { TaskPurgeService } from './task-purge.service';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { TASK_EXPORT_QUEUE } from './tasks.constants';
import { ObjectManagerModule } from '../object-manager/object-manager.module';
import { TaskExportProcessor } from './export/task-export.processor';

const workerProviders = isWorkerRuntime()
  ? [
      // Retention purge: the only path that hard-deletes, plus the cascade that keeps
      // related records from being orphaned by it. Worker-gated like every other cron —
      // an unconditional provider schedules it in every API replica too and makes the
      // Redis lock load-bearing for correctness rather than a safety net.
      TaskPurgeService,
      TaskExportProcessor,
      // RecurringTaskService moved here from the unconditional provider list. Its
      // `@Cron` fires in every process that loaded ScheduleModule, so as an
      // always-on provider it ran a cross-tenant scan once an hour in every API
      // replica. Its compare-and-set claim stopped that producing duplicate
      // tasks, but nothing stopped it producing N redundant platform-wide scans.
      RecurringTaskService,
      TaskReminderService,
    ]
  : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TaskSchemaClass.name, schema: TaskSchema },
      // The three settings collections and User are registered here because
      // TaskReferenceValidator has to confirm that every id a task points at
      // exists inside the caller's tenant before the write.
      { name: TaskStatusSchemaClass.name, schema: TaskStatusSchema },
      { name: TaskCategorySchemaClass.name, schema: TaskCategorySchema },
      { name: TaskSourceSchemaClass.name, schema: TaskSourceSchema },
      { name: UserSchemaClass.name, schema: UserSchema },
    ]),
    AutomationOutboxModule,
    CustomFieldsModule,
    ObjectManagerModule,
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
    TaskReferenceValidator,
    ...workerProviders,
  ],
  exports: [TasksService],
})
export class TasksModule {}
