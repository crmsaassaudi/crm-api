import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketRepository } from './infrastructure/persistence/document/repositories/ticket.repository';
import {
  TicketSchema,
  TicketSchemaClass,
} from './infrastructure/persistence/document/entities/ticket.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TicketSchemaClass.name, schema: TicketSchema },
    ]),
  ],
  controllers: [TicketsController],
  providers: [TicketsService, TicketRepository],
  exports: [TicketsService],
})
export class TicketsModule {}
