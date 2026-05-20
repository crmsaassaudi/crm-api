import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ActivityLogListener } from './listeners/activity-log.listener';

import { TestEventController } from './test-event.controller';
import { ActivityLogService } from './activity-log.service';
import { ActivityLogRepository } from './infrastructure/persistence/document/repositories/activity-log.repository';
import {
  ActivityLogSchema,
  ActivityLogSchemaClass,
} from './infrastructure/persistence/document/entities/activity-log.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ActivityLogSchemaClass.name, schema: ActivityLogSchema },
    ]),
  ],
  controllers: [TestEventController],
  providers: [ActivityLogListener, ActivityLogService, ActivityLogRepository],
  exports: [ActivityLogService, ActivityLogRepository],
})
export class ActivityLogModule {}
