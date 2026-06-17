import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  TicketSchema,
  TicketSchemaClass,
} from '../../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { TicketReportController } from './ticket-report.controller';
import { TicketReportService } from './ticket-report.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TicketSchemaClass.name, schema: TicketSchema },
    ]),
  ],
  controllers: [TicketReportController],
  providers: [TicketReportService],
})
export class TicketReportModule {}
