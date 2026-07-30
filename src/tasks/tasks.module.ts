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

const workerProviders = isWorkerRuntime()
  ? [
      // Retention purge: the only path that hard-deletes, plus the cascade that keeps
      // related records from being orphaned by it. Worker-gated like every other cron —
      // an unconditional provider schedules it in every API replica too and makes the
      // Redis lock load-bearing for correctness rather than a safety net.
      TaskPurgeService,
    ]
  : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TaskSchemaClass.name, schema: TaskSchema },
      { name: TaskStatusSchemaClass.name, schema: TaskStatusSchema },
    ]),
    AutomationOutboxModule,
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
