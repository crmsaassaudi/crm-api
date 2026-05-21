import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SystemSettingsSchema,
  SystemSettingsSchemaClass,
} from './entities/system-settings.schema';
import { SystemSettingsService } from './system-settings.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: SystemSettingsSchemaClass.name,
        schema: SystemSettingsSchema,
      },
    ]),
  ],
  providers: [SystemSettingsService],
  exports: [SystemSettingsService],
})
export class SystemSettingsModule {}
