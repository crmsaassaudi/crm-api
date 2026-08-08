import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../utils/document-entity-helper';
import { tenantFilterPlugin } from '../common/plugins/tenant-filter.plugin';
import { CAMPAIGN_CHANNELS, CampaignChannel } from './domain/campaign-channel';

export type CampaignRecipientDocument =
  HydratedDocument<CampaignRecipientSchemaClass>;

export const RECIPIENT_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'skipped',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

/**
 * Why a contact in the audience was not messaged.
 *
 * Recorded rather than silently dropped: "we matched 8,000 people and sent to
 * 5,200" is only answerable if the missing 2,800 each carry a reason. Without
 * this the difference reads as a bug in the send.
 */
export const SKIP_REASONS = [
  /** No email / phone on the contact for this channel. */
  'no_destination',
  /**
   * There is a value, but it cannot be delivered to — a phone with no country
   * code, where the gateway requires E.164. Kept distinct from
   * `no_destination` because the fix is different: this contact's data needs
   * correcting, that one needs filling in.
   */
  'invalid_destination',
  /** An explicit refusal — `doNotCall`, or `optIn: false` on the identity. */
  'opted_out',
  /**
   * The contact said no to THIS channel: `emailOptIn` / `smsOptIn` /
   * `whatsappOptIn` is `false`.
   *
   * Kept apart from `opted_out` because the two are answerable differently. This
   * one is per-channel and reversible by the customer; `doNotCall` is a blanket
   * refusal, and a bounced address is a data problem rather than a decision.
   */
  'consent_withdrawn',
  /** A previous send to this address hard-bounced. */
  'bounced',
  /** Another contact in the same audience shares this exact destination. */
  'duplicate',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * One row per contact per campaign — the send ledger.
 *
 * This is the module's source of truth, and the reason the whole feature can be
 * correct: it makes a send idempotent (a unique key per campaign+contact, so a
 * replayed job cannot message anyone twice), makes a pause resumable (the
 * remaining work is simply the rows still `pending`), makes "why didn't Ali get
 * it" answerable, and gives Customer 360 something to read.
 *
 * Never soft-deleted. A row saying "we emailed this person on this date" is a
 * compliance record; the campaign above it can be archived, this cannot.
 */
@Schema({ timestamps: true, collection: 'campaign_recipients' })
export class CampaignRecipientSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'CampaignSchemaClass',
    required: true,
  })
  campaignId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ContactSchemaClass',
    required: true,
  })
  contactId: string;

  @Prop({ type: String, required: true, enum: CAMPAIGN_CHANNELS })
  channel: CampaignChannel;

  /**
   * The address actually used — email, or E.164 phone.
   *
   * Frozen at materialisation time. A contact who changes their email after the
   * send must not rewrite where the message went.
   */
  // Explicit `type` on every nullable field: `string | null` is an ambiguous
  // union to Mongoose's reflection and makes the schema fail to build at boot.
  @Prop({ type: String, default: null })
  destination?: string | null;

  @Prop({
    type: String,
    required: true,
    enum: RECIPIENT_STATUSES,
    default: 'pending',
  })
  status: RecipientStatus;

  @Prop({ type: String, enum: SKIP_REASONS, default: null })
  skipReason?: SkipReason | null;

  /** Provider-side id, for correlating a delivery receipt or a support ticket. */
  @Prop({ type: String, default: null })
  providerMessageId?: string | null;

  /** Provider error, trimmed. Shown against the row in the failures list. */
  @Prop({ type: String, default: null })
  error?: string | null;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ type: Date, default: null })
  sentAt?: Date | null;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;
}

export const CampaignRecipientSchema = SchemaFactory.createForClass(
  CampaignRecipientSchemaClass,
);

CampaignRecipientSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// The idempotency key. Materialisation upserts on it, so re-running a dispatch
// job — after a worker crash, or a resume — converges instead of duplicating.
CampaignRecipientSchema.index(
  { campaignId: 1, contactId: 1 },
  { name: 'campaign_recipient_unique', unique: true },
);

// Serves both the batch pickup during a run and the per-status drill-down on the
// detail page. Also the query that decides a campaign is finished: are there any
// rows left that are neither terminal nor claimed?
CampaignRecipientSchema.index(
  { campaignId: 1, status: 1, _id: 1 },
  { name: 'campaign_recipient_status' },
);

// "Which campaigns has this contact received?" — the Customer 360 read. Sorted
// descending because that view only ever wants the most recent handful.
CampaignRecipientSchema.index(
  { tenantId: 1, contactId: 1, createdAt: -1 },
  { name: 'tenant_contact_campaign_history' },
);
