import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ContactSchema,
  ContactSchemaClass,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import {
  OmniConversationSchema,
  OmniConversationSchemaClass,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';
import {
  OmniMessageSchema,
  OmniMessageSchemaClass,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-message.schema';
import {
  DealSchema,
  DealSchemaClass,
} from '../deals/infrastructure/persistence/document/entities/deal.schema';
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';
import { RedisModule } from '../redis/redis.module';
import { ContactReportController } from './contact/contact-report.controller';
import { ContactReportRateLimitGuard } from './contact/contact-report-rate-limit.guard';
import { ContactReportService } from './contact/contact-report.service';
import { ContactGrowthRollupReader } from './contact/rollup/contact-growth-rollup.reader';
import { ContactMetricsRollupService } from './contact/rollup/contact-metrics-rollup.service';
import {
  ContactDailyMetricsSchema,
  ContactDailyMetricsSchemaClass,
} from './contact/rollup/contact-daily-metrics.schema';
import { isWorkerRuntime } from '../config/runtime-role';
import { OmniReportController } from './omni/omni-report.controller';
import { OmniReportService } from './omni/omni-report.service';
import { DealReportModule } from './deal/deal-report.module';
import { TicketReportModule } from './ticket/ticket-report.module';
import { AgentReportModule } from './agent/agent-report.module';
import { ReportDigestService } from './digest/report-digest.service';
import { ReportDigestController } from './digest/report-digest.controller';
import { MailerModule } from '../mailer/mailer.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContactSchemaClass.name, schema: ContactSchema },
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
      { name: OmniMessageSchemaClass.name, schema: OmniMessageSchema },
      {
        name: ContactDailyMetricsSchemaClass.name,
        schema: ContactDailyMetricsSchema,
      },
      { name: DealSchemaClass.name, schema: DealSchema },
    ]),
    CrmSettingsModule,
    RedisModule,
    DealReportModule,
    TicketReportModule,
    AgentReportModule,
    MailerModule,
  ],
  controllers: [
    ContactReportController,
    OmniReportController,
    ReportDigestController,
  ],
  providers: [
    ContactReportService,
    // Read side: consulted on every growth-trend request, falls back to the live
    // aggregation whenever the pre-aggregated rows cannot answer the exact question.
    ContactGrowthRollupReader,
    ContactReportRateLimitGuard,
    OmniReportService,
    ReportDigestService,
    // Write side: the nightly job belongs to the worker only. Running it in the API
    // process would put a whole-collection aggregation on the request path.
    ...(isWorkerRuntime() ? [ContactMetricsRollupService] : []),
  ],
})
export class ReportsModule {}
