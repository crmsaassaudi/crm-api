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

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TaskStatusSchemaClass.name, schema: TaskStatusSchema },
      { name: TaskCategorySchemaClass.name, schema: TaskCategorySchema },
      { name: TaskSourceSchemaClass.name, schema: TaskSourceSchema },
    ]),
  ],
  controllers: [TaskSettingsController],
  providers: [TaskSettingsService],
  exports: [TaskSettingsService],
})
export class TaskSettingsModule {}
