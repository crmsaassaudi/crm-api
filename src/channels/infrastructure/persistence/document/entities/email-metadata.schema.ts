import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type EmailMetadataDocument = HydratedDocument<EmailMetadataSchemaClass>;

/**
 * EmailMetadata — Stores email-specific headers for threading and routing.
 *
 * Kept separate from the main `messages` collection so that non-email
 * messages (Zalo, FB, WhatsApp) are not bloated with unused fields.
 *
 * Threading logic:
 *   - Use `messageId` (RFC 5322) to uniquely identify each email
 *   - Use `inReplyTo` + `references` to reconstruct thread hierarchy
 *   - "Lazy Reply" guard: if the referenced thread is >30 days old
 *     or already Closed, force a new conversation (handled in Normalizer)
 */
@Schema({
  timestamps: true,
  collection: 'email_metadata',
  toJSON: { virtuals: true, getters: true },
})
export class EmailMetadataSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  /**
   * Reference to the parent message in the `messages` collection.
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    required: true,
    index: true,
  })
  messageId: string;

  /**
   * RFC 5322 Message-ID header value.
   * Example: <abc123@mail.gmail.com>
   * Used for thread correlation and bounce detection.
   */
  @Prop({ type: String, required: true })
  emailMessageId: string;

  /**
   * In-Reply-To header — points to the parent email's Message-ID.
   * null for the first email in a thread.
   */
  @Prop({ type: String, default: null })
  inReplyTo: string | null;

  /**
   * References header — ordered list of all ancestor Message-IDs.
   * Used for deep thread reconstruction.
   */
  @Prop({ type: [String], default: [] })
  references: string[];

  /**
   * From email address (normalized lowercase).
   */
  @Prop({ type: String, required: true })
  from: string;

  /**
   * To email addresses.
   */
  @Prop({ type: [String], default: [] })
  to: string[];

  /**
   * CC recipients.
   */
  @Prop({ type: [String], default: [] })
  cc: string[];

  /**
   * BCC recipients (stored only for outbound emails sent by CRM).
   */
  @Prop({ type: [String], default: [] })
  bcc: string[];

  /**
   * CRM User ID who sent this email (outbound only).
   * Used for BCC privacy enforcement: only sender or admin can view BCC field.
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  senderId: string | null;

  /**
   * Delivery status for outbound emails.
   * Used by Bounce Handler to surface failure reasons to UI.
   *
   * Values: 'delivered' | 'bounced' | 'unknown'
   */
  @Prop({ type: String, default: 'unknown' })
  deliveryStatus: string;

  /**
   * Human-readable bounce reason, extracted from Mailer-Daemon DSN.
   * Example: "Hard bounce: Invalid recipient address"
   * Displayed as Tooltip in ChatWindow UI.
   */
  @Prop({ type: String, default: null })
  bounceReason: string | null;

  // ── Two-Way Read State Sync (Phase 2) ──────────────────────────────────

  /**
   * IMAP UID from the provider mailbox.
   * Used by ReadStateSyncProcessor to target the correct email for flag mutation.
   * May become stale if UIDValidity changes — worker falls back to Message-ID search.
   */
  @Prop({ type: Number, default: null })
  imapUid: number | null;

  /**
   * Read state sync status:
   *   - null: not yet synced (default)
   *   - 'pending': sync job queued
   *   - 'synced': \Seen flag successfully set/removed on provider
   *   - 'failed': sync failed after max retries
   */
  @Prop({
    type: String,
    enum: ['pending', 'synced', 'failed', null],
    default: null,
  })
  syncStatus: string | null;

  /**
   * Error message from the last failed sync attempt.
   * Helps Support debug without digging through BullMQ logs.
   */
  @Prop({ type: String, default: null })
  lastSyncError: string | null;
}

export const EmailMetadataSchema = SchemaFactory.createForClass(
  EmailMetadataSchemaClass,
);

// ── Indexes ───────────────────────────────────────────────────────────────

// Thread lookup: find all emails in a thread by RFC Message-ID
EmailMetadataSchema.index({ tenantId: 1, emailMessageId: 1 }, { unique: true });

// Fast lookup by internal messageId
EmailMetadataSchema.index({ messageId: 1 }, { unique: true });

// Thread reconstruction: find replies by In-Reply-To
EmailMetadataSchema.index({ tenantId: 1, inReplyTo: 1 }, { sparse: true });

// Contact lookup: find all emails from/to a specific address
EmailMetadataSchema.index({ tenantId: 1, from: 1 });
