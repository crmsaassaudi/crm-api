import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CrmSettingsController } from './crm-settings.controller';
import { CrmSettingsService } from './crm-settings.service';
import { TenantSettingsSeedingService } from './tenant-settings-seeding.service';
import { CrmSettingRepository } from './infrastructure/persistence/document/repositories/crm-setting.repository';
import {
  CrmSettingSchema,
  CrmSettingSchemaClass,
} from './infrastructure/persistence/document/entities/crm-setting.schema';
import {
  ContactSchema,
  ContactSchemaClass,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CrmSettingSchemaClass.name, schema: CrmSettingSchema },
      { name: ContactSchemaClass.name, schema: ContactSchema },
    ]),
  ],
  controllers: [CrmSettingsController],
  providers: [
    CrmSettingsService,
    TenantSettingsSeedingService,
    CrmSettingRepository,
  ],
  exports: [CrmSettingsService, TenantSettingsSeedingService],
})
export class CrmSettingsModule {}
