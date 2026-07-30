import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InboxesController } from './inboxes.controller';
import { InboxesService } from './inboxes.service';
import { InboxSchema, InboxSchemaClass } from './infrastructure/inbox.schema';
import {
  ChannelSchema,
  ChannelSchemaClass,
} from '../channels/infrastructure/persistence/document/entities/channel.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: InboxSchemaClass.name, schema: InboxSchema },
      { name: ChannelSchemaClass.name, schema: ChannelSchema },
    ]),
  ],
  controllers: [InboxesController],
  providers: [InboxesService],
  exports: [InboxesService, MongooseModule],
})
export class InboxesModule {}
