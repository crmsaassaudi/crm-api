import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketRepository } from './infrastructure/persistence/document/repositories/ticket.repository';
import {
  TicketSchema,
  TicketSchemaClass,
} from './infrastructure/persistence/document/entities/ticket.schema';
import { TicketSettingsModule } from '../ticket-settings/ticket-settings.module';
import { TicketImportProcessor } from './import/ticket-import.processor';
import { isWorkerRuntime } from '../config/runtime-role';
import { TICKET_IMPORT_QUEUE } from './tickets.constants';

const workerProviders = isWorkerRuntime() ? [TicketImportProcessor] : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TicketSchemaClass.name, schema: TicketSchema },
    ]),
    BullModule.registerQueue({
      name: TICKET_IMPORT_QUEUE,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: 200,
      },
    }),
    BullBoardModule.forFeature({
      name: TICKET_IMPORT_QUEUE,
      adapter: BullMQAdapter,
    }),
    TicketSettingsModule,
  ],
  controllers: [TicketsController],
  providers: [TicketsService, TicketRepository, ...workerProviders],
  exports: [TicketsService, TicketRepository],
})
export class TicketsModule {}
