import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MessageTemplatesController } from './message-templates.controller';
import { MessageTemplatesService } from './message-templates.service';
import { MetaWhatsAppService } from './services/meta-whatsapp.service';
import { EmailTemplateRepository } from './infrastructure/persistence/document/repositories/email-template.repository';
import { SMSTemplateRepository } from './infrastructure/persistence/document/repositories/sms-template.repository';
import { WhatsAppTemplateRepository } from './infrastructure/persistence/document/repositories/whatsapp-template.repository';
import {
  EmailTemplateSchema,
  EmailTemplateSchemaClass,
} from './infrastructure/persistence/document/entities/email-template.schema';
import {
  SMSTemplateSchema,
  SMSTemplateSchemaClass,
} from './infrastructure/persistence/document/entities/sms-template.schema';
import {
  WhatsAppTemplateSchema,
  WhatsAppTemplateSchemaClass,
} from './infrastructure/persistence/document/entities/whatsapp-template.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmailTemplateSchemaClass.name, schema: EmailTemplateSchema },
      { name: SMSTemplateSchemaClass.name, schema: SMSTemplateSchema },
      {
        name: WhatsAppTemplateSchemaClass.name,
        schema: WhatsAppTemplateSchema,
      },
    ]),
  ],
  controllers: [MessageTemplatesController],
  providers: [
    MessageTemplatesService,
    MetaWhatsAppService,
    EmailTemplateRepository,
    SMSTemplateRepository,
    WhatsAppTemplateRepository,
  ],
  exports: [
    MessageTemplatesService,
    EmailTemplateRepository,
    SMSTemplateRepository,
    WhatsAppTemplateRepository,
  ],
})
export class MessageTemplatesModule {}
