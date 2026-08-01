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
import {
  OMNI_WEBHOOK_QUEUE,
  PRIORITY_NORMAL,
} from '../queue/omni-queue.constants';
import { WebhookJobData } from '../queue/webhook-processor';
import { HIGH_THROUGHPUT_JOB_OPTIONS } from '../../queue/config/default-job-options';
import { ChannelsService } from '../../channels/channels.service';

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

      default:
        return [{ event: body, accountId: '' }];
    }
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
