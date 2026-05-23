import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';
import { BaseConsumer } from '../../queue/base.consumer';
import { InboundProcessorService } from '../processors/inbound-processor.service';
import { OMNI_WEBHOOK_QUEUE } from './omni-queue.constants';
import { ChannelType } from '../domain/omni-payload';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { ChannelsService } from '../../channels/channels.service';
import { ContactRepository } from '../../contacts/infrastructure/persistence/document/repositories/contact.repository';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

export interface WebhookJobData {
  channelType: ChannelType;
  event: any;
  accountId?: string;
  tenantId?: string;
  channelId?: string;
  channelConfig?: any;
}

/**
 * BullMQ worker that consumes webhook payloads from the queue
 * and runs them through the adapter normalization pipeline.
 *
 * Retries are handled automatically by BullMQ (3 attempts, exponential backoff).
 */
@Processor(OMNI_WEBHOOK_QUEUE)
export class WebhookProcessor extends BaseConsumer {
  protected readonly logger = new Logger(WebhookProcessor.name);
  private readonly IDEM_TTL_SECONDS = 86400;

  constructor(
    private readonly processor: InboundProcessorService,
    private readonly channelsService: ChannelsService,
    private readonly contactRepo: ContactRepository,
    private readonly cls: ClsService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<void> {
    const { channelType, event } = job.data;
    const accountId = job.data.accountId || this.extractAccountId(job.data);
    const idempotencyKey = this.buildIdempotencyKey(
      channelType,
      accountId,
      event,
      job.id,
    );
    const acquired = idempotencyKey
      ? await this.redis.set(
          idempotencyKey,
          '1',
          'EX',
          this.IDEM_TTL_SECONDS,
          'NX',
        )
      : 'OK';

    if (!acquired) {
      this.logger.debug(
        `Duplicate webhook job skipped by idempotency key ${idempotencyKey}`,
      );
      return;
    }

    try {
      const { tenantId, channelId, channelConfig } =
        await this.resolveChannelData({ ...job.data, accountId });

      await runWithTenantContext(this.cls, tenantId, async () => {
        this.logger.log(
          `Processing webhook job ${job.id} - ${channelType} for tenant ${tenantId}`,
        );

        await this.logVipSenderIfAny(tenantId, channelType, event);
        await this.processor.process(
          channelType,
          event,
          tenantId,
          channelId,
          channelConfig,
        );
      });
    } catch (error: any) {
      // NotFoundException = channel deleted/disconnected. Retry won't help.
      if (error instanceof NotFoundException) {
        this.logger.warn(
          `Job ${job.id} failed with ${error.message} — channel no longer exists, skipping retry`,
        );
        return;
      }
      // E11000 = MongoDB Duplicate Key - message was already persisted.
      // Acknowledge the job as completed to avoid BullMQ retries and log spam.
      if (error?.code === 11000) {
        this.logger.warn(
          `Duplicate message detected (E11000) in job ${job.id} - marking as completed`,
        );
        return;
      }
      if (idempotencyKey) {
        await this.redis.del(idempotencyKey).catch(() => undefined);
      }
      throw error; // Re-throw any other error so BullMQ retries normally
    }
  }

  private async resolveChannelData(data: WebhookJobData): Promise<{
    tenantId: string;
    channelId: string;
    channelConfig: any;
  }> {
    if (data.tenantId && data.channelId && data.channelConfig) {
      return {
        tenantId: data.tenantId,
        channelId: data.channelId,
        channelConfig: data.channelConfig,
      };
    }

    const accountId = data.accountId || this.extractAccountId(data);
    if (!accountId) {
      throw new Error(
        `Could not determine channel account ID from ${data.channelType} webhook`,
      );
    }

    const channel = await this.channelsService.findAnyByAccount(
      data.channelType,
      accountId,
    );

    return {
      tenantId: channel.tenantId,
      channelId: channel.id,
      channelConfig: channel,
    };
  }

  private extractAccountId(data: WebhookJobData): string {
    const event = data.event;
    switch (data.channelType) {
      case 'facebook':
      case 'instagram':
        return event?.recipient?.id ?? '';
      case 'whatsapp':
        return event?.metadata?.phone_number_id ?? '';
      case 'zalo':
        return event?.recipient?.id ?? event?.oa_id ?? '';
      default:
        return '';
    }
  }

  private extractProviderMessageId(event: any): string | null {
    const id =
      event?.message?.mid ??
      event?.message?.msg_id ??
      event?.message?.id ??
      event?.messages?.[0]?.id ??
      event?.message_id ??
      event?.msg_id ??
      event?.id;
    return id ? String(id) : null;
  }

  private buildIdempotencyKey(
    channelType: ChannelType,
    accountId?: string,
    event?: any,
    fallbackJobId?: string | number,
  ): string | null {
    const providerMessageId = this.extractProviderMessageId(event);
    if (!providerMessageId && fallbackJobId === undefined) return null;

    return `processed:webhook:${channelType}:${accountId || 'unknown'}:${
      providerMessageId ?? fallbackJobId
    }`;
  }

  private extractSenderIds(channelType: ChannelType, event: any): string[] {
    switch (channelType) {
      case 'facebook':
      case 'instagram':
      case 'zalo':
        return event?.sender?.id ? [String(event.sender.id)] : [];
      case 'whatsapp':
        return (event?.messages ?? [])
          .map((msg: any) => msg?.from)
          .filter(Boolean)
          .map(String);
      default:
        return [];
    }
  }

  private async logVipSenderIfAny(
    tenantId: string,
    channelType: ChannelType,
    event: any,
  ): Promise<void> {
    try {
      for (const senderId of this.extractSenderIds(channelType, event)) {
        if (await this.contactRepo.isVIPSender(tenantId, senderId)) {
          this.logger.log(`VIP sender detected: ${senderId}`);
          return;
        }
      }
    } catch (error: any) {
      this.logger.warn(`VIP check failed in worker: ${error.message}`);
    }
  }
}
