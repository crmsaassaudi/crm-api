import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type EmailContentDocument = HydratedDocument<EmailContentSchemaClass>;

/**
 * EmailContent — Stores the full HTML/text body of an email message.
 *
 * Separated from the main `messages` collection to keep message records
 * lightweight (few KB) while email bodies can be several MB.
 *
 * Design decisions:
 *   - `contactIds` array enables O(1) GDPR deletion queries
 *     (no need to scan conversations → messages → content)
 *   - Text index on `subject` + `textBody` for Full-Text Search
 *   - If contactIds has >1 entry (CC scenario), GDPR delete should
 *     PULL the requesting contact from the array, NOT hard-delete the record
 */
@Schema({
  timestamps: true,
  collection: 'email_contents',
  toJSON: { virtuals: true, getters: true },
})
export class EmailContentSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  /**
   * Reference back to the message in the main `messages` collection.
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    required: true,
  })
  messageId: string;

  /**
   * All contacts involved in this email (sender + recipients).
   * Used for GDPR "Right To Be Forgotten" bulk deletion.
   *
   * GDPR Logic:
   *   - If array length == 1: hard delete the entire record
   *   - If array length > 1: $pull the requesting contactId only
   */
  @Prop({
    type: [MongooseSchema.Types.ObjectId],
    ref: 'ContactSchemaClass',
    default: [],
    index: true,
  })
  contactIds: string[];

  /**
   * Email subject line. Indexed for search.
   */
  @Prop({ type: String, default: '' })
  subject: string;

  /**
   * Full HTML body of the email. Can be several MB.
   */
  @Prop({ type: String, default: '' })
  htmlBody: string;

  /**
   * Plain-text fallback body. Used for preview snippets and search.
   */
  @Prop({ type: String, default: '' })
  textBody: string;

  /**
   * References to file attachments stored in File Service (S3/local).
   * Each entry: { fileId, fileName, mimeType, sizeBytes, url }
   */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  attachments: Array<{
    fileId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    url: string;
  }>;

  /**
   * Immutable Records Policy (Appendix L):
   * CRM never deletes email records when the provider-side email is deleted.
   * This flag is set to true if we detect the source email was removed,
   * and the UI renders a [Source email deleted by user] badge.
   */
  @Prop({ type: Boolean, default: false })
  sourceDeleted: boolean;

  /**
   * Reference to the CRM conversation this email belongs to.
   * Used for efficient conversation-level email queries.
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    default: null,
  })
  conversationId: string | null;

  // ── Email Headers (denormalized for query performance) ───────

  /** Sender email address. */
  @Prop({ type: String, default: '' })
  from: string;

  /** Recipient email addresses. */
  @Prop({ type: [String], default: [] })
  to: string[];

  /** CC email addresses. */
  @Prop({ type: [String], default: [] })
  cc: string[];

  /** RFC Message-ID header. */
  @Prop({ type: String, default: null })
  rfc822MessageId: string | null;

  // ── GDPR Compliance ─────────────────────────────────────────

  /**
   * True when email content has been redacted per GDPR request.
   * Metadata (subject, from, to, timestamps) is preserved.
   */
  @Prop({ type: Boolean, default: false })
  isRedacted: boolean;

  /** Timestamp when content was redacted. */
  @Prop({ type: Date, default: null })
  redactedAt: Date | null;
}

export const EmailContentSchema = SchemaFactory.createForClass(
  EmailContentSchemaClass,
);

// ── Indexes ───────────────────────────────────────────────────────────────

// Fast lookup by messageId
EmailContentSchema.index({ messageId: 1 }, { unique: true });

// GDPR deletion: find all content for a contact
EmailContentSchema.index({ tenantId: 1, contactIds: 1 });

// GDPR auto-redact: find non-redacted emails older than N days
EmailContentSchema.index({ tenantId: 1, isRedacted: 1, createdAt: 1 });

// Conversation-level email listing
EmailContentSchema.index({ tenantId: 1, conversationId: 1 });

// Thread correlation by RFC Message-ID
EmailContentSchema.index({ tenantId: 1, rfc822MessageId: 1 }, { sparse: true });

// NOTE: Text index is NOT created here automatically.
// It must be created via a separate Migration Script to avoid
// blocking the database during app startup on large collections.
//
// Migration command:
//   db.email_contents.createIndex(
//     { subject: "text", textBody: "text" },
//     { name: "email_fulltext_search", weights: { subject: 10, textBody: 1 } }
//   );
