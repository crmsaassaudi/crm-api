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
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';
import { RedisModule } from '../redis/redis.module';
import { ContactReportController } from './contact/contact-report.controller';
import { ContactReportRateLimitGuard } from './contact/contact-report-rate-limit.guard';
import { ContactReportService } from './contact/contact-report.service';
import { OmniReportController } from './omni/omni-report.controller';
import { OmniReportService } from './omni/omni-report.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContactSchemaClass.name, schema: ContactSchema },
      { name: OmniConversationSchemaClass.name, schema: OmniConversationSchema },
      { name: OmniMessageSchemaClass.name, schema: OmniMessageSchema },
    ]),
    CrmSettingsModule,
    RedisModule,
  ],
  controllers: [ContactReportController, OmniReportController],
  providers: [
    ContactReportService,
    ContactReportRateLimitGuard,
    OmniReportService,
  ],
})
export class ReportsModule {}
