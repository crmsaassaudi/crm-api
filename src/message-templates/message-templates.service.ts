import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EmailTemplateRepository } from './infrastructure/persistence/document/repositories/email-template.repository';
import { SMSTemplateRepository } from './infrastructure/persistence/document/repositories/sms-template.repository';
import { WhatsAppTemplateRepository } from './infrastructure/persistence/document/repositories/whatsapp-template.repository';
import { MetaWhatsAppService } from './services/meta-whatsapp.service';
import { EmailTemplate } from './domain/email-template';
import { SMSTemplate } from './domain/sms-template';
import { WhatsAppTemplate } from './domain/whatsapp-template';
import {
  CreateEmailTemplateDto,
  UpdateEmailTemplateDto,
} from './dto/email-template.dto';
import {
  CreateSMSTemplateDto,
  UpdateSMSTemplateDto,
} from './dto/sms-template.dto';
import { CreateWhatsAppTemplateDto } from './dto/whatsapp-template.dto';

@Injectable()
export class MessageTemplatesService {
  constructor(
    private readonly emailRepo: EmailTemplateRepository,
    private readonly smsRepo: SMSTemplateRepository,
    private readonly waRepo: WhatsAppTemplateRepository,
    private readonly metaWAService: MetaWhatsAppService,
    private readonly cls: ClsService,
  ) {}

  // ─── EMAIL TEMPLATES CRUD ───

  async findAllEmail(): Promise<EmailTemplate[]> {
    const tenantId = this.cls.get('tenantId');
    return this.emailRepo.findAll(tenantId);
  }

  async findEmailById(id: string): Promise<EmailTemplate> {
    const tenantId = this.cls.get('tenantId');
    const template = await this.emailRepo.findById(tenantId, id);
    if (!template) throw new NotFoundException('Email template not found');
    return template;
  }

  async createEmail(dto: CreateEmailTemplateDto): Promise<EmailTemplate> {
    const tenantId = this.cls.get('tenantId');
    return this.emailRepo.create({
      ...dto,
      tenantId,
    });
  }

  async updateEmail(
    id: string,
    dto: UpdateEmailTemplateDto,
  ): Promise<EmailTemplate> {
    const tenantId = this.cls.get('tenantId');
    const updated = await this.emailRepo.update(tenantId, id, dto);
    if (!updated) throw new NotFoundException('Email template not found');
    return updated;
  }

  async deleteEmail(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const deleted = await this.emailRepo.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Email template not found');
  }

  // ─── SMS TEMPLATES CRUD ───

  async findAllSMS(): Promise<SMSTemplate[]> {
    const tenantId = this.cls.get('tenantId');
    return this.smsRepo.findAll(tenantId);
  }

  async findSMSById(id: string): Promise<SMSTemplate> {
    const tenantId = this.cls.get('tenantId');
    const template = await this.smsRepo.findById(tenantId, id);
    if (!template) throw new NotFoundException('SMS template not found');
    return template;
  }

  async createSMS(dto: CreateSMSTemplateDto): Promise<SMSTemplate> {
    const tenantId = this.cls.get('tenantId');
    return this.smsRepo.create({
      ...dto,
      tenantId,
    });
  }

  async updateSMS(id: string, dto: UpdateSMSTemplateDto): Promise<SMSTemplate> {
    const tenantId = this.cls.get('tenantId');
    const updated = await this.smsRepo.update(tenantId, id, dto);
    if (!updated) throw new NotFoundException('SMS template not found');
    return updated;
  }

  async deleteSMS(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const deleted = await this.smsRepo.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('SMS template not found');
  }

  // ─── WHATSAPP TEMPLATES CRUD & SYNC ───

  async findAllWhatsApp(): Promise<WhatsAppTemplate[]> {
    const tenantId = this.cls.get('tenantId');
    return this.waRepo.findAll(tenantId);
  }

  async findWhatsAppById(id: string): Promise<WhatsAppTemplate> {
    const tenantId = this.cls.get('tenantId');
    const template = await this.waRepo.findById(tenantId, id);
    if (!template) throw new NotFoundException('WhatsApp template not found');
    return template;
  }

  async createWhatsApp(
    dto: CreateWhatsAppTemplateDto,
  ): Promise<WhatsAppTemplate> {
    const tenantId = this.cls.get('tenantId');

    // Meta requires template names to be lowercase, alphanumeric with underscores only
    const nameRegex = /^[a-z0-9_]+$/;
    if (!nameRegex.test(dto.name)) {
      throw new BadRequestException(
        'WhatsApp template name must only contain lowercase letters, numbers, and underscores.',
      );
    }

    // Call Meta Cloud API
    const metaResult = await this.metaWAService.createTemplate(
      dto.name,
      dto.category,
      dto.language,
      dto.components,
    );

    // Save to Local DB
    return this.waRepo.create({
      ...dto,
      tenantId,
      metaTemplateId: metaResult.metaTemplateId,
      status: metaResult.status || 'PENDING',
    });
  }

  async deleteWhatsApp(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const template = await this.waRepo.findById(tenantId, id);
    if (!template) throw new NotFoundException('WhatsApp template not found');

    // Call Meta Cloud API to delete
    await this.metaWAService.deleteTemplate(template.name);

    // Delete locally
    const deleted = await this.waRepo.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('WhatsApp template not found');
  }

  async syncWhatsAppWithMeta(): Promise<WhatsAppTemplate[]> {
    const tenantId = this.cls.get('tenantId');

    // 1. Fetch templates from Meta
    const metaTemplates = await this.metaWAService.fetchTemplates();
    if (!metaTemplates || metaTemplates.length === 0) {
      return this.waRepo.findAll(tenantId);
    }

    // 2. Update status of existing local templates
    for (const mt of metaTemplates) {
      const existing = await this.waRepo.findByName(tenantId, mt.name);
      if (existing) {
        await this.waRepo.update(tenantId, existing.id, {
          status: mt.status,
          metaTemplateId: mt.id,
          components: mt.components,
        });
      } else {
        // If it exists on Meta but not locally, import it
        await this.waRepo.create({
          tenantId,
          name: mt.name,
          category: mt.category,
          language: mt.language,
          status: mt.status,
          metaTemplateId: mt.id,
          components: mt.components,
        });
      }
    }

    return this.waRepo.findAll(tenantId);
  }

  async updateWhatsAppStatus(name: string, status: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    if (tenantId) {
      await this.waRepo.updateByName(tenantId, name, { status });
    }
  }
}
