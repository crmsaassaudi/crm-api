import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { MessageTemplateRepository } from './infrastructure/persistence/document/repositories/message-template.repository';
import { TemplateVariantRepository } from './infrastructure/persistence/document/repositories/template-variant.repository';
import { TemplateReferencesService } from './services/template-references.service';
import { TemplateVariableRegistryService } from './services/template-variable-registry.service';
import { MetaWhatsAppService } from './services/meta-whatsapp.service';
import {
  CreateMessageTemplateDto,
  QueryMessageTemplateDto,
  UpdateMessageTemplateDto,
} from './dto/message-template.dto';
import {
  PreviewTemplateDto,
  UpsertTemplateVariantDto,
} from './dto/template-variant.dto';
import { MessageTemplate, TemplatePurpose } from './domain/message-template';
import { TemplateVariant } from './domain/template-variant';
import { TEMPLATE_VARIABLE_DEFINITIONS } from './domain/template-variable-definitions';

@Injectable()
export class TemplatesService {
  constructor(
    private readonly templateRepo: MessageTemplateRepository,
    private readonly variantRepo: TemplateVariantRepository,
    private readonly referencesService: TemplateReferencesService,
    private readonly variableRegistry: TemplateVariableRegistryService,
    private readonly metaWAService: MetaWhatsAppService,
    private readonly cls: ClsService,
  ) {}

  private ctx() {
    return {
      tenantId: this.cls.get('tenantId') as string,
      userId: this.cls.get('userId') as string,
    };
  }

  /** Private templates may only be read/edited by their owner; team/tenant are open to anyone in-tenant who reaches this service (route-level RequirePermission already gated entry). `manage_system` bypasses ownership entirely, for admins managing shared templates. */
  private assertCanManage(
    template: MessageTemplate,
    userId: string,
    canManageSystem: boolean,
  ) {
    if (canManageSystem) return;
    if (template.visibility === 'private' && template.ownerId !== userId) {
      throw new ForbiddenException('You can only manage your own private templates.');
    }
  }

  async findAll(query: QueryMessageTemplateDto): Promise<MessageTemplate[]> {
    const { tenantId, userId } = this.ctx();
    return this.templateRepo.findAll(tenantId, userId, query);
  }

  /** List + one variant join query — every picker UI (agent quick-reply,
   * campaign wizard, automation action config) needs both the template and
   * its content to render a usable list; fetching variants per-row would be
   * an N+1 on every popup open. */
  async findAllWithVariants(
    query: QueryMessageTemplateDto,
  ): Promise<Array<MessageTemplate & { variants: TemplateVariant[] }>> {
    const { tenantId } = this.ctx();
    const templates = await this.findAll(query);
    const variants = await this.variantRepo.findByTemplateIds(
      tenantId,
      templates.map((t) => t.id),
    );
    const byTemplate = new Map<string, TemplateVariant[]>();
    for (const variant of variants) {
      if (query.channel && variant.channel !== query.channel) continue;
      if (query.contentType && variant.contentType !== query.contentType) continue;
      const list = byTemplate.get(variant.templateId) ?? [];
      list.push(variant);
      byTemplate.set(variant.templateId, list);
    }
    const result = templates.map((t) => ({ ...t, variants: byTemplate.get(t.id) ?? [] }));
    // A channel/contentType filter narrows to templates that actually have a
    // matching variant, not just the ones that happen to exist at all.
    return query.channel || query.contentType
      ? result.filter((t) => t.variants.length > 0)
      : result;
  }

  async findById(id: string): Promise<MessageTemplate> {
    const { tenantId } = this.ctx();
    const template = await this.templateRepo.findById(tenantId, id);
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async create(dto: CreateMessageTemplateDto): Promise<MessageTemplate> {
    const { tenantId, userId } = this.ctx();
    if (dto.shortcut && !dto.purpose.includes('agent_reply')) {
      throw new BadRequestException(
        'A shortcut may only be set on templates that include the agent_reply purpose.',
      );
    }
    return this.templateRepo.create({
      tenantId,
      name: dto.name,
      purpose: dto.purpose as TemplatePurpose[],
      tags: dto.tags ?? [],
      status: 'draft',
      visibility: (dto.visibility as MessageTemplate['visibility']) ?? 'tenant',
      ownerId: userId,
      shortcut: dto.shortcut,
    });
  }

  async update(
    id: string,
    dto: UpdateMessageTemplateDto,
    canManageSystem: boolean,
  ): Promise<MessageTemplate> {
    const { tenantId, userId } = this.ctx();
    const existing = await this.findById(id);
    this.assertCanManage(existing, userId, canManageSystem);
    const updated = await this.templateRepo.update(tenantId, id, dto as Partial<MessageTemplate>);
    if (!updated) throw new NotFoundException('Template not found');
    return updated;
  }

  async delete(id: string, canManageSystem: boolean): Promise<{ warning?: string }> {
    const { tenantId, userId } = this.ctx();
    const existing = await this.findById(id);
    this.assertCanManage(existing, userId, canManageSystem);
    const { warning } = await this.referencesService.assertDeletable(tenantId, id);
    await this.templateRepo.softDelete(tenantId, id);
    await this.variantRepo.deleteByTemplate(tenantId, id);
    return { warning };
  }

  async listVariants(id: string): Promise<TemplateVariant[]> {
    const { tenantId } = this.ctx();
    await this.findById(id); // 404s if missing/soft-deleted
    return this.variantRepo.findByTemplate(tenantId, id);
  }

  async upsertVariant(
    id: string,
    dto: UpsertTemplateVariantDto,
    canManageSystem: boolean,
  ): Promise<TemplateVariant> {
    const { tenantId, userId } = this.ctx();
    const template = await this.findById(id);
    this.assertCanManage(template, userId, canManageSystem);

    this.validateVariantContent(template, dto);

    let providerBinding: TemplateVariant['providerBinding'] | undefined;
    if (dto.channel === 'whatsapp' && dto.whatsapp) {
      const nameRegex = /^[a-z0-9_]+$/;
      if (!nameRegex.test(template.name)) {
        throw new BadRequestException(
          'WhatsApp requires the template name to contain only lowercase letters, numbers, and underscores.',
        );
      }
      const metaResult = await this.metaWAService.createTemplate(
        template.name,
        dto.whatsapp.category,
        dto.locale,
        dto.whatsapp.components,
      );
      providerBinding = {
        provider: 'meta_whatsapp',
        externalId: metaResult.metaTemplateId,
        category: dto.whatsapp.category as any,
        approvalStatus: (metaResult.status as any) || 'PENDING',
        components: dto.whatsapp.components,
        syncedAt: new Date(),
      };
    }

    return this.variantRepo.upsert(tenantId, id, dto.channel, dto.locale, {
      contentType: (dto.contentType as any) ?? 'text',
      subject: dto.subject,
      body: dto.body,
      htmlContent: dto.htmlContent,
      designJson: dto.designJson,
      buttons: dto.buttons as any,
      cards: dto.cards as any,
      attachments: dto.attachments,
      ...(providerBinding ? { providerBinding } : {}),
    });
  }

  async deleteVariant(
    id: string,
    variantId: string,
    canManageSystem: boolean,
  ): Promise<void> {
    const { tenantId, userId } = this.ctx();
    const template = await this.findById(id);
    this.assertCanManage(template, userId, canManageSystem);
    const variant = await this.variantRepo.findById(tenantId, variantId);
    if (!variant || variant.templateId !== id) {
      throw new NotFoundException('Variant not found');
    }
    if (variant.channel === 'whatsapp') {
      await this.metaWAService.deleteTemplate(template.name);
    }
    await this.variantRepo.delete(tenantId, variantId);
  }

  /** Strict-mode templates (agent_reply/campaign/bot) may only reference the
   * declarative registry; a token unknown to every strict purpose the template
   * declares is rejected here, not discovered by the customer. Automation-only
   * templates skip this — their variable universe is the broader per-module
   * field set, validated by the automation workflow builder itself. */
  private validateVariantContent(
    template: MessageTemplate,
    dto: UpsertTemplateVariantDto,
  ): void {
    const strictPurposes = template.purpose.filter((p) => p !== 'automation');
    if (strictPurposes.length === 0) return;

    const texts = [dto.subject, dto.body, dto.htmlContent].filter(
      (t): t is string => !!t,
    );
    for (const text of texts) {
      const results = strictPurposes.map((purpose) =>
        this.variableRegistry.validate(text, { mode: 'strict', purpose }),
      );
      const unknownEverywhere = (results[0]?.unknownTokens ?? []).filter((token) =>
        results.every((r) => r.unknownTokens.includes(token)),
      );
      if (unknownEverywhere.length > 0) {
        throw new BadRequestException(
          `Unknown template variable(s): ${unknownEverywhere.map((t) => `{{${t}}}`).join(', ')}. ` +
            `Pick from the variable list instead of typing tokens by hand.`,
        );
      }
    }
  }

  listVariables(purpose: TemplatePurpose) {
    return this.variableRegistry.listVariables(purpose);
  }

  async preview(id: string, dto: PreviewTemplateDto): Promise<{ subject?: string; body?: string; htmlContent?: string }> {
    const { tenantId } = this.ctx();
    await this.findById(id);
    const variant = await this.variantRepo.findOne(tenantId, id, dto.channel, dto.locale);
    if (!variant) throw new NotFoundException('No variant for that channel/locale');

    const sampleData = TEMPLATE_VARIABLE_DEFINITIONS.reduce<Record<string, any>>(
      (acc, def) => {
        const [ns, field] = def.path.split('.');
        acc[ns] = acc[ns] ?? {};
        acc[ns][field] = def.sampleValue;
        return acc;
      },
      {},
    );

    const render = (text?: string) =>
      text ? this.variableRegistry.render(text, sampleData, { mode: 'strict', purpose: 'campaign' }) : undefined;

    return {
      subject: render(variant.subject),
      body: render(variant.body),
      htmlContent: render(variant.htmlContent),
    };
  }

  /**
   * Pull every template from Meta and upsert local variants keyed by
   * (templateId, channel, locale) — the fix for the audit's multi-language
   * bug. Each (name, language) pair now maps to its own row instead of one
   * document per name, so importing `order_confirm/ar` can no longer overwrite
   * `order_confirm/en`.
   */
  async syncWhatsApp(): Promise<void> {
    const { tenantId, userId } = this.ctx();
    const metaTemplates = await this.metaWAService.fetchTemplates();

    for (const mt of metaTemplates) {
      let template = await this.templateRepo.findByName(tenantId, mt.name);
      if (!template) {
        template = await this.templateRepo.create({
          tenantId,
          name: mt.name,
          purpose: ['campaign'],
          tags: [],
          status: 'published',
          visibility: 'tenant',
          ownerId: userId,
        });
      }
      await this.variantRepo.upsert(tenantId, template.id, 'whatsapp', mt.language, {
        contentType: 'text',
        providerBinding: {
          provider: 'meta_whatsapp',
          externalId: mt.id,
          category: mt.category,
          approvalStatus: mt.status,
          components: mt.components,
          syncedAt: new Date(),
        },
      });
    }
  }

  async uploadWhatsAppMedia(file: Express.Multer.File): Promise<{ mediaId: string }> {
    const mediaId = await this.metaWAService.uploadMedia(
      file.buffer,
      file.originalname,
      file.mimetype,
    );
    return { mediaId };
  }
}
