import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CrmSettingsController } from './crm-settings.controller';
import { CrmSettingsService } from './crm-settings.service';
import { CrmSettingRepository } from './infrastructure/persistence/document/repositories/crm-setting.repository';
import { CrmSettingSchema, CrmSettingSchemaClass } from './infrastructure/persistence/document/entities/crm-setting.schema';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: CrmSettingSchemaClass.name, schema: CrmSettingSchema },
        ]),
    ],
    controllers: [CrmSettingsController],
    providers: [CrmSettingsService, CrmSettingRepository],
    exports: [CrmSettingsService],
})
export class CrmSettingsModule { }
