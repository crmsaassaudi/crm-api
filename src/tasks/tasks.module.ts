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

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TaskSchemaClass.name, schema: TaskSchema },
      { name: TaskStatusSchemaClass.name, schema: TaskStatusSchema },
    ]),
  ],
  controllers: [TasksController],
  providers: [TasksService, TaskRepository, RecurringTaskService],
  exports: [TasksService],
})
export class TasksModule {}
