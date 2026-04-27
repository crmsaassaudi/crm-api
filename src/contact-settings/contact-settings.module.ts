import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContactSettingsController } from './contact-settings.controller';
import { ContactSettingsService } from './contact-settings.service';
import {
  ContactStatusSchemaClass,
  ContactStatusSchema,
} from './entities/contact-status.schema';
import {
  ContactSourceSchemaClass,
  ContactSourceSchema,
} from './entities/contact-source.schema';
import {
  ContactLifecycleStageSchemaClass,
  ContactLifecycleStageSchema,
} from './entities/contact-lifecycle-stage.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContactStatusSchemaClass.name, schema: ContactStatusSchema },
      { name: ContactSourceSchemaClass.name, schema: ContactSourceSchema },
      {
        name: ContactLifecycleStageSchemaClass.name,
        schema: ContactLifecycleStageSchema,
      },
    ]),
  ],
  controllers: [ContactSettingsController],
  providers: [ContactSettingsService],
  exports: [ContactSettingsService],
})
export class ContactSettingsModule {}
