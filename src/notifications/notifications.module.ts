import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import {
  NotificationSchema,
  NotificationSchemaClass,
} from './infrastructure/persistence/document/entities/notification.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NotificationSchemaClass.name, schema: NotificationSchema },
    ]),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
