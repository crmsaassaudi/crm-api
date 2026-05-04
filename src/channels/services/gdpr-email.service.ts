import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmailContentSchemaClass } from '../infrastructure/persistence/document/entities/email-content.schema';

/**
 * GdprEmailService — Enterprise GDPR compliance for email data.
 *
 * Implements three key compliance workflows:
 *
 * 1. **Multi-Party Contact Deletion (Appendix A)**
 *    When Contact A requests deletion, only their reference is removed from
 *    `contactIds[]`. The email content persists for other contacts until ALL
 *    references are removed. Only then is the content redacted.
 *
 * 2. **Content Redaction**
 *    Replaces email HTML/text body with a standardised notice. Metadata
 *    (subject, from, to, timestamps) is preserved for audit trail but the
 *    actual message content is destroyed.
 *
 * 3. **Auto-Redact (Optional)**
 *    Tenant-configurable: automatically redact email content after N days.
 *    Designed for financial/legal sector tenants (MiFID II, SOX).
 */
@Injectable()
export class GdprEmailService {
  private readonly logger = new Logger(GdprEmailService.name);
  private readonly REDACTED_NOTICE =
    '[Email content redacted per data deletion request]';

  constructor(
    @InjectModel(EmailContentSchemaClass.name)
    private readonly emailContentModel: Model<EmailContentSchemaClass>,
  ) {}

  /**
   * Remove a contact reference from all emails.
   * If the email has no remaining contact references after removal,
   * redact its content entirely.
   *
   * @param contactId - The CRM Contact ID to remove
   * @param tenantId - Tenant scope
   * @returns Summary of processed emails
   */
  async removeContactReference(
    contactId: string,
    tenantId: string,
  ): Promise<{
    emailsScanned: number;
    referencesRemoved: number;
    emailsRedacted: number;
  }> {
    this.logger.log(
      `[GDPR] Removing contact ${contactId} references for tenant ${tenantId}`,
    );

    // Find all emails that reference this contact
    const emails = await this.emailContentModel
      .find({
        tenantId,
        contactIds: contactId,
      })
      .exec();

    let referencesRemoved = 0;
    let emailsRedacted = 0;

    for (const email of emails) {
      // Remove this contact from the contactIds array
      const updatedContactIds = (email.contactIds || []).filter(
        (id: string) => id.toString() !== contactId.toString(),
      );

      referencesRemoved++;

      if (updatedContactIds.length === 0) {
        // No more contact references → redact the content
        await this.redactEmailContent(email._id.toString(), tenantId);
        emailsRedacted++;
      } else {
        // Other contacts still reference this email → only remove the ID
        await this.emailContentModel.updateOne(
          { _id: email._id, tenantId },
          { $set: { contactIds: updatedContactIds } },
        );
      }
    }

    this.logger.log(
      `[GDPR] Completed for contact ${contactId}: ` +
        `${emails.length} scanned, ${referencesRemoved} refs removed, ${emailsRedacted} redacted`,
    );

    return {
      emailsScanned: emails.length,
      referencesRemoved,
      emailsRedacted,
    };
  }

  /**
   * Redact the content of a specific email.
   * Preserves metadata (from, to, subject, timestamps) for audit trail.
   * Destroys HTML body, text body, and attachment content.
   */
  async redactEmailContent(
    emailContentId: string,
    tenantId: string,
  ): Promise<boolean> {
    const result = await this.emailContentModel.updateOne(
      { _id: emailContentId, tenantId },
      {
        $set: {
          htmlBody: `<p>${this.REDACTED_NOTICE}</p>`,
          textBody: this.REDACTED_NOTICE,
          attachments: [],
          isRedacted: true,
          redactedAt: new Date(),
        },
      },
    );

    return result.modifiedCount > 0;
  }

  /**
   * Auto-redact emails older than the specified number of days.
   * Called by a scheduled cronjob.
   *
   * @param tenantId - Tenant scope
   * @param retentionDays - Number of days to retain content
   * @returns Number of emails redacted
   */
  async autoRedactExpiredEmails(
    tenantId: string,
    retentionDays: number,
  ): Promise<number> {
    if (retentionDays <= 0) return 0;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.emailContentModel.updateMany(
      {
        tenantId,
        createdAt: { $lt: cutoffDate },
        isRedacted: { $ne: true },
      },
      {
        $set: {
          htmlBody: `<p>${this.REDACTED_NOTICE}</p>`,
          textBody: this.REDACTED_NOTICE,
          attachments: [],
          isRedacted: true,
          redactedAt: new Date(),
        },
      },
    );

    if (result.modifiedCount > 0) {
      this.logger.log(
        `[GDPR AutoRedact] Tenant ${tenantId}: redacted ${result.modifiedCount} emails older than ${retentionDays} days`,
      );
    }

    return result.modifiedCount;
  }

  /**
   * Export all email data for a specific contact (GDPR Right to Access / Portability).
   * Returns metadata only — content is streamed separately.
   */
  async exportContactEmailMetadata(
    contactId: string,
    tenantId: string,
  ): Promise<{
    totalEmails: number;
    emails: Array<{
      id: string;
      subject: string;
      from: string;
      to: string[];
      createdAt: Date;
      isRedacted: boolean;
    }>;
  }> {
    const emails = await this.emailContentModel
      .find(
        {
          tenantId,
          contactIds: contactId,
        },
        {
          _id: 1,
          subject: 1,
          from: 1,
          to: 1,
          createdAt: 1,
          isRedacted: 1,
        },
      )
      .exec();

    return {
      totalEmails: emails.length,
      emails: emails.map((e: any) => ({
        id: e._id.toString(),
        subject: e.subject,
        from: e.from,
        to: e.to,
        createdAt: e.createdAt,
        isRedacted: e.isRedacted || false,
      })),
    };
  }
}
