import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomFieldsController } from './custom-fields.controller';
import { MeCustomFieldsController } from './me-custom-fields.controller';
import { CustomFieldsService } from './custom-fields.service';
import { CustomFieldRepository } from './infrastructure/persistence/document/repositories/custom-field.repository';
import {
  CustomFieldSchema,
  CustomFieldSchemaClass,
} from './infrastructure/persistence/document/entities/custom-field.schema';
import { CustomFieldValueValidator } from './custom-field-value.validator';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CustomFieldSchemaClass.name, schema: CustomFieldSchema },
    ]),
  ],
  controllers: [CustomFieldsController, MeCustomFieldsController],
  providers: [
    CustomFieldsService,
    CustomFieldRepository,
    CustomFieldValueValidator,
  ],
  exports: [CustomFieldsService, CustomFieldValueValidator],
})
export class CustomFieldsModule {}
