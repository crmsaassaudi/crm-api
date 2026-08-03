import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TaskSettingsController } from './task-settings.controller';
import { TaskSettingsService } from './task-settings.service';
import {
  TaskStatusSchemaClass,
  TaskStatusSchema,
} from './entities/task-status.schema';
import {
  TaskCategorySchemaClass,
  TaskCategorySchema,
} from './entities/task-category.schema';
import {
  TaskSourceSchemaClass,
  TaskSourceSchema,
} from './entities/task-source.schema';
import {
  TaskSchemaClass,
  TaskSchema,
} from '../tasks/infrastructure/persistence/document/entities/task.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TaskStatusSchemaClass.name, schema: TaskStatusSchema },
      { name: TaskCategorySchemaClass.name, schema: TaskCategorySchema },
      { name: TaskSourceSchemaClass.name, schema: TaskSourceSchema },
      // Registered so a delete can check whether any task still references the
      // setting. Model registration rather than importing TasksModule, which
      // would create a cycle: TasksModule already needs the settings schemas for
      // TaskReferenceValidator.
      { name: TaskSchemaClass.name, schema: TaskSchema },
    ]),
  ],
  controllers: [TaskSettingsController],
  providers: [TaskSettingsService],
  exports: [TaskSettingsService],
})
export class TaskSettingsModule {}
