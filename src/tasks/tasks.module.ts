import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskRepository } from './infrastructure/persistence/document/repositories/task.repository';
import {
  TaskSchema,
  TaskSchemaClass,
} from './infrastructure/persistence/document/entities/task.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TaskSchemaClass.name, schema: TaskSchema },
    ]),
  ],
  controllers: [TasksController],
  providers: [TasksService, TaskRepository],
  exports: [TasksService],
})
export class TasksModule {}
