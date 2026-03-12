import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { ChannelRepository } from './infrastructure/persistence/document/repositories/channel.repository';
import {
  ChannelSchema,
  ChannelSchemaClass,
} from './infrastructure/persistence/document/entities/channel.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChannelSchemaClass.name, schema: ChannelSchema },
    ]),
  ],
  controllers: [ChannelsController],
  providers: [ChannelsService, ChannelRepository],
  exports: [ChannelsService],
})
export class ChannelsModule {}
