import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  MessageTemplateSchema,
  MessageTemplateSchemaClass,
} from './infrastructure/persistence/document/entities/message-template.schema';
import {
  TemplateVariantSchema,
  TemplateVariantSchemaClass,
} from './infrastructure/persistence/document/entities/template-variant.schema';
import {
  TemplateUsageSchema,
  TemplateUsageSchemaClass,
} from './infrastructure/persistence/document/entities/template-usage.schema';
import {
  CampaignSchema,
  CampaignSchemaClass,
} from '../campaigns/campaign.schema';
import {
  AutomationWorkflowSchema,
  AutomationWorkflowSchemaClass,
} from '../automation-rules/infrastructure/persistence/document/entities/automation-workflow.schema';
import { MessageTemplateRepository } from './infrastructure/persistence/document/repositories/message-template.repository';
import { TemplateVariantRepository } from './infrastructure/persistence/document/repositories/template-variant.repository';
import { TemplateUsageRepository } from './infrastructure/persistence/document/repositories/template-usage.repository';
import { TemplateVariableRegistryService } from './services/template-variable-registry.service';
import { TemplateReferencesService } from './services/template-references.service';
import { TemplateUsageService } from './services/template-usage.service';
import { MetaWhatsAppService } from './services/meta-whatsapp.service';
import { TemplatesService } from './templates.service';
import { TemplatesController } from './templates.controller';

/**
 * Registers the Campaign and AutomationWorkflow schemas directly (not their
 * owning modules) purely so `TemplateReferencesService` can run its
 * count/reference checks. CampaignsModule already imports ChannelsModule,
 * which itself depends on this module — importing CampaignsModule or
 * AutomationRulesModule back in here would close a require cycle at boot.
 * Reading a collection through its own `@InjectModel` needs neither module's
 * providers nor its controllers, so this stays a one-directional dependency.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MessageTemplateSchemaClass.name, schema: MessageTemplateSchema },
      { name: TemplateVariantSchemaClass.name, schema: TemplateVariantSchema },
      { name: TemplateUsageSchemaClass.name, schema: TemplateUsageSchema },
      { name: CampaignSchemaClass.name, schema: CampaignSchema },
      {
        name: AutomationWorkflowSchemaClass.name,
        schema: AutomationWorkflowSchema,
      },
    ]),
  ],
  controllers: [TemplatesController],
  providers: [
    MessageTemplateRepository,
    TemplateVariantRepository,
    TemplateUsageRepository,
    TemplateVariableRegistryService,
    TemplateReferencesService,
    TemplateUsageService,
    MetaWhatsAppService,
    TemplatesService,
  ],
  exports: [
    MessageTemplateRepository,
    TemplateVariantRepository,
    TemplateVariableRegistryService,
    TemplateUsageService,
    MetaWhatsAppService,
    TemplatesService,
  ],
})
export class TemplatesModule {}
