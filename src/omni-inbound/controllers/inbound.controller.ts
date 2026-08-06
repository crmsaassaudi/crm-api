import {
  Controller,
  Post,
  Body,
  Param,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  PayloadTooLargeException,
  Get,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { SkipThrottle } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { Public } from 'nest-keycloak-connect';
import { InboundProcessorService } from '../processors/inbound-processor.service';
import { ChannelType } from '../domain/omni-payload';
import { isSupportedChannel } from '../domain/channel-capabilities';
import {
  OMNI_WEBHOOK_QUEUE,
  PRIORITY_NORMAL,
} from '../queue/omni-queue.constants';
import { WebhookJobData } from '../queue/webhook-processor';
import { HIGH_THROUGHPUT_JOB_OPTIONS } from '../../queue/config/default-job-options';
import { ChannelsService } from '../../channels/channels.service';

/**
 * How far back a provider event may be dated and still be accepted.
 *
 * 6 hours: long enough to cover a provider replaying a backlog after an outage on
 * their side, short enough that a captured request stops being useful.
 */
const DEFAULT_REPLAY_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * The provider's own timestamp for an event, in epoch milliseconds, or null when
 * the payload carries none we recognise.
 *
 * Providers disagree on both the field and the unit: Meta sends seconds on
 * Messenger (`timestamp` on the entry) and milliseconds on some payloads,
 * WhatsApp sends a string of seconds, Zalo sends milliseconds. A value in seconds
 * is promoted by magnitude rather than by channel, so a new channel needs no
 * change here.
 */
function extractProviderTimestamp(event: any): number | null {
  const raw =
    event?.timestamp ??
    event?.messages?.[0]?.timestamp ??
    event?.message?.timestamp ??
    event?.create_time ??
    event?.event?.create_time;

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  // Anything below ~year 2286 in ms is a seconds value; treat it as such.
  return numeric < 1e11 ? numeric * 1000 : numeric;
}

/**
 * Webhook receiver for all messaging providers.
 *
 * URL pattern: POST /omni/webhook/:channelType
 *
 * The hot path validates the signature, splits provider batches, enqueues the
 * raw event, and returns 200 OK. Tenant/channel resolution and VIP checks run
 * in the BullMQ worker so provider retries are not caused by database latency.
 */
@Controller({ path: 'omni/webhook', version: '1' })
@Public()
// Webhooks arrive from provider egress IPs (Meta/Zalo) which can legitimately
// burst from a small pool of addresses; IP-based throttling would 429 valid
// deliveries and cause provider retries / message loss. Signature validation
// (HMAC / mac) is the real gate here, so skip the global rate limiter.
// Throttlers are named (burst/medium/long), so a bare @SkipThrottle() —
// which targets a throttler named "default" — would be a no-op; skip each.
@SkipThrottle({ burst: true, medium: true, long: true })
export class InboundController {
  private readonly logger = new Logger(InboundController.name);

  constructor(
    private readonly processor: InboundProcessorService,
    private readonly configService: ConfigService,
    private readonly channels: ChannelsService,
    @InjectQueue(OMNI_WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
  ) {}

  /**
   * Facebook Messenger & WhatsApp share the same webhook verification
   * challenge for initial setup.
   */
  @Get(':channelType')
  @HttpCode(HttpStatus.OK)
  verifyWebhook(
    @Param('channelType') channelType: string,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const expectedToken = this.configService.get<string>('OMNI_VERIFY_TOKEN', {
      infer: true,
    });

    if (!expectedToken) {
      this.logger.error(
        'OMNI_VERIFY_TOKEN env var is not configured — webhook verification will fail',
      );
      return 'forbidden';
    }

    if (mode === 'subscribe' && verifyToken === expectedToken) {
      this.logger.log(`Webhook verification for ${channelType}: SUCCESS`);
      return challenge;
    }

    this.logger.warn(
      `Webhook verification for ${channelType}: FAILED (token mismatch)`,
    );
    return 'forbidden';
  }

  /**
   * Receive inbound webhook events from any provider.
   */
  @Post(':channelType')
  @HttpCode(HttpStatus.OK)
  async receiveWebhook(
    @Param('channelType') channelType: ChannelType,
    @Headers() headers: Record<string, string>,
    @Body() body: any,
    @Req() req: Request,
  ) {
    this.logger.log(`Received ${channelType} webhook`);

    // Reject a channel the platform does not implement, at the door.
    // `:channelType` is caller-controlled, so without this an unimplemented
    // channel reached the queue and failed three retries deep in a worker, where
    // it looks like an infrastructure fault rather than a configuration one.
    if (!isSupportedChannel(channelType)) {
      throw new BadRequestException(`Unsupported channel: ${channelType}`);
    }

    // rawBody is populated by the express.json verify hook in main.ts.
    // We forward the original bytes to the adapter so HMAC verification
    // cannot be bypassed by JSON re-serialization quirks.
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const maxPayloadBytes = this.getMaxPayloadBytes();
    if (rawBody && rawBody.byteLength > maxPayloadBytes) {
      this.logger.warn(
        `Rejected ${channelType} webhook payload: ${rawBody.byteLength} bytes exceeds ${maxPayloadBytes}`,
      );
      throw new PayloadTooLargeException(
        `Webhook payload exceeds ${maxPayloadBytes} bytes`,
      );
    }

    // Unwrapping is pure parsing of the untrusted body, and it is what tells us
    // which channel the request claims to be from — which is what selects the
    // signing secret. Nothing is trusted or enqueued until validation passes.
    const events = this.unwrapEvents(channelType, body);

    const isValid = this.processor.validateWebhook(
      channelType,
      headers,
      body,
      rawBody,
      await this.resolveChannelSecret(channelType, events),
    );
    if (!isValid) {
      this.logger.warn(`Invalid webhook signature for ${channelType}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    this.rejectStaleEvents(channelType, events);

    const jobs = events.map(({ event, accountId }) => ({
      name: 'process-webhook',
      data: {
        channelType,
        event,
        accountId,
      } as WebhookJobData,
      opts: {
        jobId: this.buildDeterministicJobId(channelType, accountId, event),
        // These were five inlined literals that happened to reproduce
        // HIGH_THROUGHPUT_JOB_OPTIONS exactly, while the shared constant sat with
        // no reader — the same drift risk as any copied config. Only removeOnFail
        // differs from the preset (webhooks keep a deeper failure tail for RCA).
        ...HIGH_THROUGHPUT_JOB_OPTIONS,
        priority: PRIORITY_NORMAL,
        removeOnFail: { count: 5000, age: 60 * 60 * 24 * 7 },
      },
    }));

    await this.webhookQueue.addBulk(jobs);

    this.logger.log(`Queued ${jobs.length} ${channelType} event(s)`);
    return { status: 'ok', queued: jobs.length };
  }

  /**
   * Split a provider batch into individual events, each carrying the account it
   * actually belongs to.
   *
   * The account MUST be derived per event. Meta batches events for several
   * Pages / phone numbers into one POST, so reading it once from `entry[0]`
   * stamped every event in the batch with the first entry's account — which
   * resolved the whole batch to that account's channel, and therefore its
   * tenant. Messages for one tenant's Page were persisted inside another
   * tenant's data with no guard tripping, because tenantId and channelId were
   * consistently (and consistently wrongly) taken from the same channel.
   */
  /**
   * The signing secret of the channel this batch belongs to, or `undefined` to
   * let the adapter use its env-level secret.
   *
   * Only resolved when the batch names exactly one account. A batch spanning
   * several accounts can only come from a provider that signs with one shared
   * app secret (Meta), and picking one account's secret to authenticate another
   * account's events would be worse than using the app secret.
   *
   * A lookup failure yields `undefined` rather than a rejection: the env secret
   * is still a valid gate, and a database blip must not turn into dropped
   * webhooks.
   */
  private async resolveChannelSecret(
    channelType: ChannelType,
    events: Array<{ accountId: string }>,
  ): Promise<string | undefined> {
    const accounts = new Set(events.map((e) => e.accountId).filter(Boolean));
    if (accounts.size !== 1) return undefined;

    const [account] = [...accounts];
    try {
      const channel = await this.channels.findAnyByAccount(
        channelType.toLowerCase(),
        account,
      );
      const secret = channel?.credentials?.webhookSecret;
      return typeof secret === 'string' && secret ? secret : undefined;
    } catch {
      this.logger.debug(
        `No channel for ${channelType}/${account} — verifying with the env secret`,
      );
      return undefined;
    }
  }

  /**
   * Reject events whose provider timestamp is outside the replay window.
   *
   * Meta's signature covers the body and nothing else — no timestamp, no nonce — so
   * a captured signed request stays valid forever and can be replayed. Deduplication
   * bounded that only while the BullMQ job id and the Redis idempotency key survived
   * retention; after eviction the same payload was accepted as new, which on a
   * message webhook means re-delivering a customer's message and on a delivery
   * receipt means resurrecting a stale status.
   *
   * The window is generous: providers retry for hours after an outage and those
   * retries are legitimate. This closes replay of *old* traffic, not slow traffic.
   * Events with no readable timestamp pass — a fabricated one would be worse than
   * none, and the signature still had to verify.
   */
  private rejectStaleEvents(
    channelType: ChannelType,
    events: Array<{ event: any }>,
  ): void {
    const oldestAllowed = Date.now() - this.getReplayWindowMs();

    for (const { event } of events) {
      const timestamp = extractProviderTimestamp(event);
      if (timestamp === null) continue;
      if (timestamp >= oldestAllowed) continue;

      this.logger.warn(
        `Rejected ${channelType} webhook: event timestamp ` +
          `${new Date(timestamp).toISOString()} is outside the replay window`,
      );
      throw new BadRequestException('Webhook event is too old');
    }
  }

  private getReplayWindowMs(): number {
    const configured = Number(
      this.configService.get<string>('OMNI_WEBHOOK_REPLAY_WINDOW_MS', {
        infer: true,
      }),
    );
    return Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_REPLAY_WINDOW_MS;
  }

  private unwrapEvents(
    channelType: ChannelType,
    body: any,
  ): Array<{ event: any; accountId: string }> {
    switch (channelType) {
      case 'facebook':
      case 'instagram':
        // Instagram uses the same entry[].messaging[] structure as Facebook.
        return (body.entry ?? []).flatMap((entry: any) =>
          (entry.messaging ?? []).map((event: any) => ({
            event,
            accountId: String(entry?.id ?? ''),
          })),
        );

      case 'whatsapp':
        return (body.entry ?? []).flatMap((entry: any) =>
          (entry.changes ?? []).map((change: any) => ({
            event: change?.value,
            accountId: String(change?.value?.metadata?.phone_number_id ?? ''),
          })),
        );

      case 'zalo':
        return [{ event: body, accountId: this.extractZaloOaId(body) }];

      // The account is the business's own open_id — the *recipient* of a customer
      // message. Falling through to the default here meant TikTok events carried
      // an empty accountId, so the worker could resolve neither a channel nor a
      // tenant and every TikTok message died in the retry/DLQ path.
      case 'tiktok':
        return [{ event: body, accountId: this.extractTikTokAccountId(body) }];

      default:
        return [{ event: body, accountId: '' }];
    }
  }

  /**
   * The TikTok account a webhook belongs to.
   *
   * `to_user.open_id` is the business account on an inbound direct message.
   * `client_key` identifies the *app* rather than the account, so it is only a
   * fallback for single-account apps — a multi-account app would resolve every
   * account's traffic to whichever channel was stored under the client key.
   */
  private extractTikTokAccountId(body: any): string {
    const recipient = body?.event?.to_user?.open_id;
    if (recipient) return String(recipient);
    return String(body?.client_key ?? '');
  }

  /**
   * The Official Account id, which is the `account` a Zalo channel is stored
   * under.
   *
   * Zalo puts the OA in `recipient` for user→OA events and in `sender` for
   * OA→user echoes; `oa_id` is authoritative when the payload carries it.
   * Reading `sender.id` first (the previous behaviour) yielded the *customer's*
   * user id for every inbound message, so the channel lookup always missed and
   * every Zalo message was dropped as "channel no longer exists".
   */
  private extractZaloOaId(body: any): string {
    if (body?.oa_id) return String(body.oa_id);

    const sentByOa = String(body?.event_name ?? '').startsWith('oa_');
    const oaId = sentByOa ? body?.sender?.id : body?.recipient?.id;
    return String(oaId ?? '');
  }

  /**
   * Stable id so a provider re-delivery collapses onto the same queue job.
   *
   * Events without a provider message id (delivery/read receipts) fall back to
   * a hash of the event itself. The previous fallback was the event's index in
   * the batch, which gave every such event the same id and let BullMQ discard
   * all but the first.
   */
  private buildDeterministicJobId(
    channelType: ChannelType,
    accountId: string,
    event: any,
  ): string {
    const providerMessageId =
      event?.message?.mid ??
      event?.message?.msg_id ??
      event?.message?.id ??
      event?.messages?.[0]?.id ??
      event?.message_id ??
      event?.msg_id ??
      event?.id ??
      JSON.stringify(event ?? null);

    return createHash('sha256')
      .update(`${channelType}:${accountId || 'unknown'}:${providerMessageId}`)
      .digest('hex');
  }

  private getMaxPayloadBytes(): number {
    const configured = Number(
      this.configService.get<string>('OMNI_WEBHOOK_MAX_PAYLOAD_BYTES', {
        infer: true,
      }),
    );
    return Number.isInteger(configured) && configured > 0
      ? configured
      : 2 * 1024 * 1024;
  }
}
