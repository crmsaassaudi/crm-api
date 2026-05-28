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
  Get,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
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
export class InboundController {
  private readonly logger = new Logger(InboundController.name);

  constructor(
    private readonly processor: InboundProcessorService,
    private readonly configService: ConfigService,
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
    const expectedToken = this.configService.get<string>(
      'OMNI_VERIFY_TOKEN',
      { infer: true },
    );

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

    const isValid = this.processor.validateWebhook(
      channelType,
      headers,
      body,
      rawBody,
    );
    if (!isValid) {
      this.logger.warn(`Invalid webhook signature for ${channelType}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    const events = this.unwrapEvents(channelType, body);
    const accountId = this.extractAccountId(channelType, body);

    const jobs = events.map((event, index) => ({
      name: 'process-webhook',
      data: {
        channelType,
        event,
        accountId,
      } as WebhookJobData,
      opts: {
        jobId: this.buildDeterministicJobId(
          channelType,
          accountId,
          event,
          index,
        ),
        priority: PRIORITY_NORMAL,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 1000, age: 60 * 60 * 6 },
        removeOnFail: { count: 5000, age: 60 * 60 * 24 * 7 },
      },
    }));

    await this.webhookQueue.addBulk(jobs);

    this.logger.log(`Queued ${jobs.length} ${channelType} event(s)`);
    return { status: 'ok', queued: jobs.length };
  }

  private unwrapEvents(channelType: ChannelType, body: any): any[] {
    switch (channelType) {
      case 'facebook':
        return (body.entry ?? []).flatMap(
          (entry: any) => entry.messaging ?? [],
        );

      case 'whatsapp':
        return (body.entry ?? []).flatMap((entry: any) =>
          (entry.changes ?? []).map((change: any) => change.value),
        );

      case 'zalo':
        return [body];

      default:
        return [body];
    }
  }

  private extractAccountId(channelType: ChannelType, body: any): string {
    switch (channelType) {
      case 'facebook':
      case 'instagram':
        return body.entry?.[0]?.id ?? '';
      case 'whatsapp':
        return (
          body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? ''
        );
      case 'zalo':
        return body.sender?.id ?? body.recipient?.id ?? body.oa_id ?? '';
      default:
        return '';
    }
  }

  private extractSenderIds(channelType: ChannelType, events: any[]): string[] {
    const ids = new Set<string>();
    for (const event of events) {
      try {
        switch (channelType) {
          case 'facebook':
          case 'instagram':
            if (event?.sender?.id) ids.add(event.sender.id);
            break;
          case 'whatsapp':
            for (const msg of event?.messages ?? []) {
              if (msg?.from) ids.add(msg.from);
            }
            break;
          case 'zalo':
            if (event?.sender?.id) ids.add(event.sender.id);
            break;
          default:
            break;
        }
      } catch {
        // Skip malformed events.
      }
    }
    return Array.from(ids);
  }

  private buildDeterministicJobId(
    channelType: ChannelType,
    accountId: string,
    event: any,
    index: number,
  ): string {
    const senderId =
      this.extractSenderIds(channelType, [event])[0] ?? 'unknown';
    const providerMessageId =
      event?.message?.mid ??
      event?.message?.msg_id ??
      event?.message?.id ??
      event?.messages?.[0]?.id ??
      event?.message_id ??
      event?.msg_id ??
      event?.id ??
      index;

    return createHash('sha256')
      .update(
        `${channelType}:${accountId || 'unknown'}:${senderId}:${providerMessageId}`,
      )
      .digest('hex');
  }
}
