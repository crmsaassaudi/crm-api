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
import { TicketExportProcessor } from './export/ticket-export.processor';
import { isWorkerRuntime } from '../config/runtime-role';
import { TICKET_IMPORT_QUEUE, TICKET_EXPORT_QUEUE } from './tickets.constants';
import {
  ImportJobSchema,
  ImportJobSchemaClass,
} from '../common/import/import-job.schema';

const workerProviders = isWorkerRuntime()
  ? [TicketImportProcessor, TicketExportProcessor]
  : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TicketSchemaClass.name, schema: TicketSchema },
      { name: ImportJobSchemaClass.name, schema: ImportJobSchema },
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
    BullModule.registerQueue({
      name: TICKET_EXPORT_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
    BullBoardModule.forFeature({
      name: TICKET_EXPORT_QUEUE,
      adapter: BullMQAdapter,
    }),
    TicketSettingsModule,
  ],
  controllers: [TicketsController],
  providers: [TicketsService, TicketRepository, ...workerProviders],
  exports: [TicketsService, TicketRepository],
})
export class TicketsModule {}
