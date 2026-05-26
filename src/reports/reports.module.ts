import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ContactSchema,
  ContactSchemaClass,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';
import { RedisModule } from '../redis/redis.module';
import { ContactReportController } from './contact/contact-report.controller';
import { ContactReportRateLimitGuard } from './contact/contact-report-rate-limit.guard';
import { ContactReportService } from './contact/contact-report.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContactSchemaClass.name, schema: ContactSchema },
    ]),
    CrmSettingsModule,
    RedisModule,
  ],
  controllers: [ContactReportController],
  providers: [ContactReportService, ContactReportRateLimitGuard],
})
export class ReportsModule {}
