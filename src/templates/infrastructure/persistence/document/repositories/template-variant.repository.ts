import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TemplateVariant } from '../../../../domain/template-variant';
import {
  TemplateVariantSchemaClass,
  TemplateVariantSchemaDocument,
} from '../entities/template-variant.schema';
import { TemplateVariantMapper } from '../mappers/template-variant.mapper';

@Injectable()
export class TemplateVariantRepository {
  constructor(
    @InjectModel(TemplateVariantSchemaClass.name)
    private readonly model: Model<TemplateVariantSchemaDocument>,
  ) {}

  async findByTemplate(
    tenantId: string,
    templateId: string,
  ): Promise<TemplateVariant[]> {
    const docs = await this.model.find({ tenantId, templateId }).exec();
    return docs.map(TemplateVariantMapper.toDomain);
  }

  /** One query for a whole list page — the join `findAllWithVariants` needs so a
   * template list (agent quick-reply picker, campaign/automation pickers) never
   * turns into an N+1 fetch of each template's content. */
  async findByTemplateIds(
    tenantId: string,
    templateIds: string[],
  ): Promise<TemplateVariant[]> {
    if (templateIds.length === 0) return [];
    const docs = await this.model.find({ tenantId, templateId: { $in: templateIds } }).exec();
    return docs.map(TemplateVariantMapper.toDomain);
  }

  async findOne(
    tenantId: string,
    templateId: string,
    channel: string,
    locale: string,
  ): Promise<TemplateVariant | null> {
    const doc = await this.model
      .findOne({ tenantId, templateId, channel, locale })
      .exec();
    return doc ? TemplateVariantMapper.toDomain(doc) : null;
  }

  async findById(tenantId: string, id: string): Promise<TemplateVariant | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? TemplateVariantMapper.toDomain(doc) : null;
  }

  /** Two-query lookup (by name via the caller, then by channel+locale here) — see
   * MessageTemplate's unique {tenantId,name} index. Deliberately not denormalizing
   * `name` onto the variant: at this volume (hundreds to low thousands of templates
   * per tenant) two indexed queries cost nothing, and it keeps the parent the only
   * place `name` is stored. This two-step lookup is exactly what fixes the WhatsApp
   * sync bug — each (name, language) pair now resolves to its own variant row
   * instead of overwriting a single per-name document. */
  async findWhatsAppVariantByTemplateAndLanguage(
    tenantId: string,
    templateId: string,
    language: string,
  ): Promise<TemplateVariant | null> {
    return this.findOne(tenantId, templateId, 'whatsapp', language);
  }

  async upsert(
    tenantId: string,
    templateId: string,
    channel: string,
    locale: string,
    data: Partial<TemplateVariant>,
  ): Promise<TemplateVariant> {
    const doc = await this.model
      .findOneAndUpdate(
        { tenantId, templateId, channel, locale },
        {
          $set: TemplateVariantMapper.toPersistence({
            ...data,
            tenantId,
            templateId,
            channel: channel as any,
            locale,
          }),
        },
        { new: true, upsert: true },
      )
      .exec();
    return TemplateVariantMapper.toDomain(doc);
  }

  /** Applies a Meta approval-status webhook to the matching variant(s) of an
   * already-resolved template. When `language` is omitted (older webhook
   * payloads without it), every WhatsApp variant of the template is updated —
   * matching the old single-collection behaviour, just no longer able to
   * clobber a different language's row since each language is its own row now. */
  async updateApprovalStatus(
    tenantId: string,
    templateId: string,
    language: string | undefined,
    approvalStatus: string,
  ): Promise<void> {
    const filter: Record<string, unknown> = {
      tenantId,
      templateId,
      channel: 'whatsapp',
    };
    if (language) filter.locale = language;
    await this.model
      .updateMany(
        filter,
        { $set: { 'providerBinding.approvalStatus': approvalStatus } },
      )
      .exec();
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }

  async deleteByTemplate(tenantId: string, templateId: string): Promise<void> {
    await this.model.deleteMany({ tenantId, templateId }).exec();
  }
}
