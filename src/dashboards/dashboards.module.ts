import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardSchemaClass, DashboardSchema } from './dashboard.schema';
import { DashboardsService } from './dashboards.service';
import { DashboardSummaryService } from './dashboard-summary.service';
import { DashboardsController } from './dashboards.controller';
import {
  DealSchema,
  DealSchemaClass,
} from '../deals/infrastructure/persistence/document/entities/deal.schema';
import {
  TicketSchema,
  TicketSchemaClass,
} from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import {
  OmniConversationSchema,
  OmniConversationSchemaClass,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DashboardSchemaClass.name, schema: DashboardSchema },
      // Read-only models for the home KPI aggregation. Registered here rather
      // than importing the owning modules so this stays a leaf — a dashboard
      // must not drag the deal/ticket/omni service graphs into its own.
      { name: DealSchemaClass.name, schema: DealSchema },
      { name: TicketSchemaClass.name, schema: TicketSchema },
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
    ]),
  ],
  controllers: [DashboardsController],
  providers: [DashboardsService, DashboardSummaryService],
  exports: [DashboardsService],
})
export class DashboardsModule {}
