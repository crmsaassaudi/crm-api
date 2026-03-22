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
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Public } from 'nest-keycloak-connect';
import { InboundProcessorService } from '../processors/inbound-processor.service';
import { ChannelType } from '../domain/omni-payload';
import { ChannelsService } from '../../channels/channels.service';
import { OMNI_WEBHOOK_QUEUE } from '../queue/omni-queue.constants';
import { WebhookJobData } from '../queue/webhook-processor';

/**
 * Webhook receiver for all messaging providers.
 *
 * URL pattern:  POST /omni/webhook/:channelType
 *
 * Instead of processing webhooks inline (which risks timeout under load),
 * this controller pushes each event to the BullMQ `omni-webhooks` queue
 * and immediately returns 200 OK to the provider.
 */
@Controller({ path: 'omni/webhook', version: '1' })
@Public() // Webhooks are unauthenticated — validated via HMAC signatures
export class InboundController {
  private readonly logger = new Logger(InboundController.name);

  constructor(
    private readonly processor: InboundProcessorService,
    private readonly channelsService: ChannelsService,
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
    const expectedToken = this.configService.get('OMNI_VERIFY_TOKEN') || 'crm_omni_24';
    
    if (mode === 'subscribe' && verifyToken === expectedToken) {
      this.logger.log(`Webhook verification for ${channelType}: SUCCESS`);
      return challenge;
    }
    
    this.logger.warn(`Webhook verification for ${channelType}: FAILED (token mismatch)`);
    return 'forbidden';
  }

  /**
   * Receive inbound webhook events from any provider.
   *
   * Validates the signature, unwraps the batch, and pushes each
   * individual event to the queue (fire-and-forget).
   */
  @Post(':channelType')
  @HttpCode(HttpStatus.OK)
  async receiveWebhook(
    @Param('channelType') channelType: ChannelType,
    @Headers() headers: Record<string, string>,
    @Body() body: any,
  ) {
    this.logger.log(`Received ${channelType} webhook`);

    // Validate the webhook signature
    const isValid = this.processor.validateWebhook(channelType, headers, body);
    if (!isValid) {
      this.logger.warn(`Invalid webhook signature for ${channelType}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    // Resolve context
    const { tenantId, channelId } = await this.resolveChannelData(channelType, body);

    // Unwrap batch wrappers per-provider
    const events = this.unwrapEvents(channelType, body);

    // Push each event to the queue — non-blocking, returns 200 immediately
    const jobs = events.map((event, index) => ({
      name: 'process-webhook',
      data: {
        channelType,
        event,
        tenantId,
        channelId,
      } as WebhookJobData,
      opts: {
        jobId: `${channelType}-${Date.now()}-${index}`,
      },
    }));

    await this.webhookQueue.addBulk(jobs);

    this.logger.log(`Queued ${jobs.length} ${channelType} event(s)`);
    return { status: 'ok', queued: jobs.length };
  }

  /**
   * Each provider wraps individual message events in a different batch structure.
   * This method peels off the wrapper and returns an array of per-event objects.
   */
  private unwrapEvents(channelType: ChannelType, body: any): any[] {
    switch (channelType) {
      case 'facebook':
        // FB: entry[].messaging[] — flatten all messaging arrays
        return (body.entry ?? []).flatMap(
          (entry: any) => entry.messaging ?? [],
        );

      case 'whatsapp':
        // WA Cloud API: entry[].changes[].value (which contains messages[])
        return (body.entry ?? []).flatMap(
          (entry: any) =>
            (entry.changes ?? []).map((change: any) => change.value),
        );

      case 'zalo':
        // Zalo sends one event per request
        return [body];

      default:
        return [body];
    }
  }

  /**
   * Resolve tenant and channel ID from the webhook body identifiers.
   */
  private async resolveChannelData(
    channelType: ChannelType,
    body: any,
  ): Promise<{ tenantId: string; channelId: string }> {
    let accountId = '';
    
    switch (channelType) {
      case 'facebook':
      case 'instagram':
        accountId = body.entry?.[0]?.id; // Usually the page ID
        break;
      case 'whatsapp':
        accountId = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
        break;
      case 'zalo':
        accountId = body.sender?.id; // Or whatever oa_id is
        break;
      default:
        break;
    }

    if (!accountId) {
      this.logger.warn(`Could not determine channel account ID from webhook body for type ${channelType}`);
      throw new BadRequestException('Could not determine channel account ID from webhook');
    }

    const dbType = channelType.charAt(0).toUpperCase() + channelType.slice(1);
    try {
      const channel = await this.channelsService.findAnyByAccount(dbType, accountId);
      return { tenantId: channel.tenant, channelId: channel.id };
    } catch (err) {
      this.logger.error(`Channel not found for account ${accountId} (type: ${dbType})`);
      throw new BadRequestException('Channel not found');
    }
  }
}
