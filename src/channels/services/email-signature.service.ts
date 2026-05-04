import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

/**
 * Email Signature Service — Manages per-user, per-channel email signatures.
 *
 * Architecture (from email-integration-plan.md Section 3.1e):
 *   - Each user can have one signature per channel config
 *   - Signatures are stored as HTML (editable via TipTap on frontend)
 *   - Auto-import from Gmail API is a future feature (OAuth2 phase)
 *   - Signatures are automatically appended to outbound emails
 *   - The Signature Fence [ref:CRM-{id}:ref] is appended BELOW the signature
 *
 * Why separate from UserSettings:
 *   - Signatures are channel-specific (different sig for Gmail vs Outlook)
 *   - They contain HTML that can be large (logos, formatted text)
 *   - Future: auto-sync from provider APIs requires its own lifecycle
 */

export interface EmailSignature {
  id?: string;
  tenantId: string;
  userId: string;
  configId: string;
  /** HTML content of the signature */
  htmlContent: string;
  /** Plain text fallback */
  textContent: string;
  /** Whether this is the active signature for this user+config */
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── MongoDB Schema Registration ────────────────────────────────────────────
// The schema is defined inline since it's a simple document.
// For production, move to a separate schema file in entities/ directory.

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type EmailSignatureDocument =
  HydratedDocument<EmailSignatureSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'email_signatures',
  toJSON: { virtuals: true, getters: true },
})
export class EmailSignatureSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  userId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ChannelConfigSchemaClass',
    required: true,
  })
  configId: string;

  @Prop({ type: String, default: '' })
  htmlContent: string;

  @Prop({ type: String, default: '' })
  textContent: string;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;
}

export const EmailSignatureSchema = SchemaFactory.createForClass(
  EmailSignatureSchemaClass,
);

// One signature per user per channel config
EmailSignatureSchema.index(
  { tenantId: 1, userId: 1, configId: 1 },
  { unique: true },
);

// ── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class EmailSignatureService {
  private readonly logger = new Logger(EmailSignatureService.name);

  constructor(
    @InjectModel(EmailSignatureSchemaClass.name)
    private readonly signatureModel: Model<EmailSignatureDocument>,
  ) {}

  /**
   * Get the active signature for a user+config combination.
   * Returns null if no signature is configured.
   */
  async getSignature(
    tenantId: string,
    userId: string,
    configId: string,
  ): Promise<EmailSignature | null> {
    const doc = await this.signatureModel.findOne({
      tenantId,
      userId,
      configId,
      isActive: true,
    });
    return doc ? this.toInterface(doc) : null;
  }

  /**
   * Create or update a signature for a user+config.
   * Uses upsert to handle both create and update in one call.
   */
  async upsertSignature(
    tenantId: string,
    userId: string,
    configId: string,
    htmlContent: string,
  ): Promise<EmailSignature> {
    // Generate plain text fallback
    const textContent = this.htmlToPlainText(htmlContent);

    const doc = await this.signatureModel.findOneAndUpdate(
      { tenantId, userId, configId },
      {
        $set: {
          htmlContent,
          textContent,
          isActive: true,
        },
        $setOnInsert: {
          tenantId,
          userId,
          configId,
        },
      },
      { upsert: true, new: true },
    );

    this.logger.log(
      `[EmailSignature] Upserted signature for user=${userId}, config=${configId}`,
    );

    return this.toInterface(doc);
  }

  /**
   * Delete a signature.
   */
  async deleteSignature(
    tenantId: string,
    userId: string,
    configId: string,
  ): Promise<boolean> {
    const result = await this.signatureModel.deleteOne({
      tenantId,
      userId,
      configId,
    });
    return result.deletedCount > 0;
  }

  /**
   * Get all signatures for a user (across all channel configs).
   */
  async getUserSignatures(
    tenantId: string,
    userId: string,
  ): Promise<EmailSignature[]> {
    const docs = await this.signatureModel.find({
      tenantId,
      userId,
      isActive: true,
    });
    return docs.map((d) => this.toInterface(d));
  }

  /**
   * Wrap signature HTML with the Signature Fence marker.
   * The fence [ref:CRM-{conversationId}:ref] is appended BELOW the signature
   * for Layer 2 thread correlation (see email-integration-plan.md Section 5.4).
   *
   * @param signatureHtml - The user's HTML signature
   * @param conversationId - CRM conversation ID for thread correlation
   * @returns HTML string with signature + fence marker
   */
  wrapWithSignatureFence(
    signatureHtml: string,
    conversationId: string,
  ): string {
    const fence = `<p style="font-size:9px; color:#aaa; border-top:1px solid #eee; margin-top:16px;">[ref:CRM-${conversationId}:ref]</p>`;

    if (!signatureHtml) {
      // No signature — just append the fence
      return fence;
    }

    return `<div class="crm-email-signature" style="margin-top:20px;">${signatureHtml}</div>${fence}`;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private htmlToPlainText(html: string): string {
    if (!html) return '';
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  private toInterface(doc: any): EmailSignature {
    return {
      id: doc._id?.toString() || doc.id,
      tenantId: doc.tenantId?.toString(),
      userId: doc.userId?.toString(),
      configId: doc.configId?.toString(),
      htmlContent: doc.htmlContent,
      textContent: doc.textContent,
      isActive: doc.isActive,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
