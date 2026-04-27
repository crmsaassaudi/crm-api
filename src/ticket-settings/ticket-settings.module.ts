import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TicketSettingsController } from './ticket-settings.controller';
import { TicketSettingsService } from './ticket-settings.service';
import {
  TicketStatusSchemaClass,
  TicketStatusSchema,
} from './entities/ticket-status.schema';
import {
  TicketTypeSchemaClass,
  TicketTypeSchema,
} from './entities/ticket-type.schema';
import {
  TicketSourceSchemaClass,
  TicketSourceSchema,
} from './entities/ticket-source.schema';
import {
  TicketResolutionCodeSchemaClass,
  TicketResolutionCodeSchema,
} from './entities/ticket-resolution-code.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TicketStatusSchemaClass.name, schema: TicketStatusSchema },
      { name: TicketTypeSchemaClass.name, schema: TicketTypeSchema },
      { name: TicketSourceSchemaClass.name, schema: TicketSourceSchema },
      {
        name: TicketResolutionCodeSchemaClass.name,
        schema: TicketResolutionCodeSchema,
      },
    ]),
  ],
  controllers: [TicketSettingsController],
  providers: [TicketSettingsService],
  exports: [TicketSettingsService],
})
export class TicketSettingsModule {}
