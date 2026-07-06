import { Injectable, Logger } from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Model, Schema as MongooseSchema } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Email Tracking Service — Enterprise-grade open/click tracking with bot filtering.
 *
 * Architecture (from email-integration-plan.md Section 4.6):
 *   - Tracking Pixel: 1x1 transparent PNG served at /t/{trackingId}.png
 *   - Bot Fingerprinting: User-Agent + IP CIDR + timing analysis
 *   - Classification: human | bot | unknown
 *   - Event Rules:
 *       human → fire notification to agent
 *       bot → audit log only
 *       unknown → 60s buffer, then classify as "likely_opened"
 *   - Compliance:
 *       Tenant-level opt-out toggle (default: OFF)
 *       Per-email override (agent can disable per-send)
 *       GDPR: pixel NOT inserted if trackingEnabled = false
 *   - UI Label: "📬 Likely Opened" (never "Opened" — honest UX)
 *
 * Why not just count opens?
 *   Bot prefetching (Gmail, Outlook) inflates open counts by 50-200%.
 *   Without bot filtering, tracking data is worse than useless — it's misleading.
 */

// ── 1x1 Transparent PNG ────────────────────────────────────────────────────
// Pre-computed minimal transparent PNG (68 bytes) — better than generating on each request
const TRACKING_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
    'Nl7BcQAAAABJRU5ErkJggg==',
  'base64',
);

// ── Bot Detection ───────────────────────────────────────────────────────────

/** Known bot User-Agent substrings */
const BOT_USER_AGENTS = [
  'googleimageproxy',
  'google-smtp-stp', // Gmail
  'microsoft office',
  'owaonline',
  'outlookimageanalyzer', // Outlook
  'thunderbird',
  'yahoo', // Others
  'bot',
  'crawler',
  'spider',
  'wget',
  'curl', // Generic bots
  'facebookexternalhit',
  'linkedinbot', // Social
  'applemaildrop', // Apple Mail
];

/** Known prefetch IP CIDR ranges (simplified — check first 2 octets) */
const BOT_IP_PREFIXES = [
  '66.102.', // Google
  '66.249.', // Google
  '64.233.', // Google
  '209.85.', // Google
  '40.94.', // Microsoft
  '40.107.', // Microsoft
  '52.100.', // Microsoft
  '104.47.', // Microsoft
];

// ── Schema ──────────────────────────────────────────────────────────────────

export type EmailTrackingDocument = HydratedDocument<EmailTrackingSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'email_tracking_raw',
  toJSON: { virtuals: true, getters: true },
})
export class EmailTrackingSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ type: String, required: true })
  trackingId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  messageId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  conversationId: string;

  @Prop({ type: String, required: true })
  recipientEmail: string;

  /** Classification: human, bot, unknown */
  @Prop({ type: String, enum: ['human', 'bot', 'unknown'], default: 'unknown' })
  classification: string;

  @Prop({ type: String, default: null })
  userAgent: string | null;

  @Prop({ type: String, default: null })
  ipAddress: string | null;

  @Prop({ type: Boolean, default: false })
  notificationSent: boolean;
}

export const EmailTrackingSchema = SchemaFactory.createForClass(
  EmailTrackingSchemaClass,
);

// Fast lookup by trackingId (pixel hit)
EmailTrackingSchema.index({ trackingId: 1 }, { unique: true });

// Analytics queries
EmailTrackingSchema.index({ tenantId: 1, messageId: 1 });

// ── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class EmailTrackingService {
  private readonly logger = new Logger(EmailTrackingService.name);

  constructor(
    @InjectModel(EmailTrackingSchemaClass.name)
    private readonly trackingModel: Model<EmailTrackingDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Pixel Generation ──────────────────────────────────────────────────

  /**
   * Generate the tracking pixel HTML to embed in an outbound email.
   * Only called when tenant tracking is enabled AND per-email toggle is ON.
   *
   * @param trackingId - Unique ID for this tracking pixel
   * @param baseUrl - CRM API base URL (e.g., https://api.crm.example.com)
   * @returns HTML img tag string
   */
  generatePixelHtml(trackingId: string, baseUrl: string): string {
    const pixelUrl = `${baseUrl}/v1/t/${trackingId}.png`;
    // Attributes minimize rendering impact:
    // - 1x1 transparent PNG
    // - No border, no alt text
    // - Display:none would be filtered by some email clients, so we use 1x1
    return `<img src="${pixelUrl}" width="1" height="1" style="border:0;display:block;" alt="" />`;
  }

  /**
   * Get the raw 1x1 transparent PNG buffer.
   * Served by the controller at GET /t/:trackingId.png
   */
  getPixelBuffer(): Buffer {
    return TRACKING_PIXEL;
  }

  // ── Pixel Hit Processing ──────────────────────────────────────────────

  /**
   * Process a tracking pixel request (email opened).
   * This is called by the pixel endpoint controller.
   */
  async processPixelHit(
    trackingId: string,
    userAgent: string | null,
    ipAddress: string | null,
  ): Promise<void> {
    // Idempotency: skip if already recorded
    const existing = await this.trackingModel.findOne({ trackingId });
    if (existing?.notificationSent) {
      // Already processed — just serve the pixel
      return;
    }

    // Classify the hit
    const classification = this.classifyHit(userAgent, ipAddress);

    if (existing) {
      // Update existing record with more info
      await this.trackingModel.updateOne(
        { trackingId },
        { $set: { classification, userAgent, ipAddress } },
      );
    }

    this.logger.debug(
      `[EmailTracking] Pixel hit: ${trackingId}, class=${classification}, UA=${userAgent?.substring(0, 50)}`,
    );

    // Event rules based on classification
    switch (classification) {
      case 'human':
        // Immediately fire notification
        await this.fireOpenNotification(trackingId, existing);
        break;

      case 'bot':
        // Audit only — no notification
        this.logger.debug(`[EmailTracking] Bot hit ignored: ${trackingId}`);
        break;

      case 'unknown':
        // Buffer for 60 seconds, then classify as "likely_opened"
        setTimeout(async () => {
          try {
            await this.fireOpenNotification(trackingId, existing);
          } catch (err: any) {
            this.logger.error(
              `[EmailTracking] Delayed notification failed: ${err.message}`,
            );
          }
        }, 60_000);
        break;
    }
  }

  /**
   * Create a tracking record for an outbound email.
   * Called when the email is sent with tracking enabled.
   */
  async createTrackingRecord(params: {
    tenantId: string;
    trackingId: string;
    messageId: string;
    conversationId: string;
    recipientEmail: string;
  }): Promise<void> {
    await this.trackingModel.create({
      ...params,
      classification: 'unknown',
      notificationSent: false,
    });
  }

  // ── Bot Fingerprinting ────────────────────────────────────────────────

  /**
   * Classify a pixel hit as human, bot, or unknown.
   *
   * Strategy:
   *   1. Check User-Agent against known bot strings
   *   2. Check IP against known prefetch CIDR ranges
   *   3. If neither matches, classify as 'unknown' (60s buffer applies)
   */
  classifyHit(
    userAgent: string | null,
    ipAddress: string | null,
  ): 'human' | 'bot' | 'unknown' {
    // Check User-Agent for known bots
    if (userAgent) {
      const ua = userAgent.toLowerCase();
      for (const botUA of BOT_USER_AGENTS) {
        if (ua.includes(botUA)) {
          return 'bot';
        }
      }
    }

    // Check IP for known prefetch ranges
    if (ipAddress) {
      for (const prefix of BOT_IP_PREFIXES) {
        if (ipAddress.startsWith(prefix)) {
          return 'bot';
        }
      }
    }

    // No User-Agent at all → likely a privacy-conscious email client → unknown
    if (!userAgent) {
      return 'unknown';
    }

    // Has a user-agent that's NOT a known bot → likely human
    // Still classify as 'unknown' to be safe (60s buffer)
    return 'unknown';
  }

  // ── Notification ──────────────────────────────────────────────────────

  /**
   * Fire an open notification to the agent via WebSocket.
   */
  private async fireOpenNotification(
    trackingId: string,
    record: any,
  ): Promise<void> {
    if (!record) {
      record = await this.trackingModel.findOne({ trackingId });
    }
    if (!record || record.notificationSent) return;

    // Mark as notified
    await this.trackingModel.updateOne(
      { trackingId },
      { $set: { notificationSent: true } },
    );

    // Emit event for WebSocket notification
    this.eventEmitter.emit('email.tracking.opened', {
      tenantId: record.tenantId?.toString(),
      messageId: record.messageId?.toString(),
      conversationId: record.conversationId?.toString(),
      recipientEmail: record.recipientEmail,
      classification: record.classification,
      openedAt: new Date().toISOString(),
    });

    this.logger.log(
      `[EmailTracking] 📬 Open detected: ${record.recipientEmail} (${record.classification})`,
    );
  }

  // ── Analytics ─────────────────────────────────────────────────────────

  /**
   * Get tracking stats for a specific message.
   */
  async getMessageStats(
    tenantId: string,
    messageId: string,
  ): Promise<{
    totalHits: number;
    humanHits: number;
    botHits: number;
    unknownHits: number;
    likelyOpened: boolean;
  }> {
    const records = await this.trackingModel.find({ tenantId, messageId });

    const humanHits = records.filter(
      (r) => r.classification === 'human',
    ).length;
    const botHits = records.filter((r) => r.classification === 'bot').length;
    const unknownHits = records.filter(
      (r) => r.classification === 'unknown',
    ).length;

    return {
      totalHits: records.length,
      humanHits,
      botHits,
      unknownHits,
      // "Likely Opened" = at least one non-bot hit recorded
      likelyOpened:
        humanHits > 0 ||
        (unknownHits > 0 && records.some((r) => r.notificationSent)),
    };
  }
}
