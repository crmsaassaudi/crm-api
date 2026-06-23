import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RichMessageTemplatesController } from './rich-message-templates.controller';
import { RichMessageTemplatesService } from './rich-message-templates.service';
import { RichMessageTemplateRepository } from './infrastructure/persistence/document/repositories/rich-message-template.repository';
import {
  RichMessageTemplateSchema,
  RichMessageTemplateSchemaClass,
} from './infrastructure/persistence/document/entities/rich-message-template.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: RichMessageTemplateSchemaClass.name,
        schema: RichMessageTemplateSchema,
      },
    ]),
  ],
  controllers: [RichMessageTemplatesController],
  providers: [RichMessageTemplatesService, RichMessageTemplateRepository],
  exports: [RichMessageTemplatesService],
})
export class RichMessageTemplatesModule {}
