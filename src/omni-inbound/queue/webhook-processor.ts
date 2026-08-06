import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { BaseConsumer } from '../../queue/base.consumer';
import { InboundProcessorService } from '../processors/inbound-processor.service';
import { OMNI_WEBHOOK_QUEUE } from './omni-queue.constants';
import { ChannelType } from '../domain/omni-payload';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { ChannelsService } from '../../channels/channels.service';
import { ContactRepository } from '../../contacts/infrastructure/persistence/document/repositories/contact.repository';
import { IdempotencyService } from '../../redis/idempotency.service';
import { MetricsService } from '../../observability/metrics.service';
import { OMNI_CONCURRENCY } from '../../queue/config/worker-concurrency';

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
@Processor(OMNI_WEBHOOK_QUEUE, { concurrency: OMNI_CONCURRENCY.webhook() })
export class WebhookProcessor extends BaseConsumer {
  protected readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private readonly processor: InboundProcessorService,
    private readonly channelsService: ChannelsService,
    private readonly contactRepo: ContactRepository,
    private readonly cls: ClsService,
    private readonly idempotency: IdempotencyService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<void> {
    const { channelType, event } = job.data;
    const accountId = job.data.accountId || this.extractAccountId(job.data);
    // Dedup by provider message ID only. A BullMQ retry gets a fresh job.id, so
    // falling back to job.id would let a later redelivery through as new.
    const idempotencyKey = this.buildIdempotencyKey(
      channelType,
      accountId,
      event,
    );

    // Claim, don't mark. The key only becomes a permanent "handled" marker in
    // `commit()` below — an attempt killed mid-flight leaves a lease that
    // expires, so the retry reprocesses instead of being skipped as a duplicate.
    if (idempotencyKey) {
      const claimed = await this.idempotency.claim(
        idempotencyKey,
        String(job.id ?? job.name),
      );
      if (!claimed) {
        this.logger.debug(`Duplicate webhook skipped: ${idempotencyKey}`);
        this.countDropped(channelType, 'duplicate');
        return;
      }
    }

    try {
      const { tenantId, channelId, channelConfig } =
        await this.resolveChannelData({ ...job.data, accountId });

      await runWithTenantContext(this.cls, tenantId, async () => {
        this.logger.debug(
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

      if (idempotencyKey) await this.idempotency.commit(idempotencyKey);
    } catch (error: any) {
      // The channel is gone or was never connected. Retrying cannot help, but
      // this is still a dropped customer message: record it, forward it to the
      // DLQ so it is visible, and release the claim so a redelivery after the
      // channel is reconnected can be processed.
      if (error instanceof NotFoundException) {
        this.logger.error(
          `Dropping ${channelType} webhook for account ${accountId}: ${error.message}`,
        );
        this.countDropped(channelType, 'channel_not_found');
        if (idempotencyKey) await this.idempotency.release(idempotencyKey);
        await this.dlqService?.sendToDlq(OMNI_WEBHOOK_QUEUE, job, error);
        return;
      }
      // E11000 = the message is already persisted, so the work is done.
      if (error?.code === 11000) {
        this.logger.debug(
          `Message in job ${job.id} was already persisted (E11000)`,
        );
        if (idempotencyKey) await this.idempotency.commit(idempotencyKey);
        return;
      }
      // Everything else retries under the same owner, which re-enters its own
      // claim. No compensating delete is needed, and none would be reliable:
      // a `catch` block does not run for an OOM kill.
      throw error;
    }
  }

  private countDropped(channelType: ChannelType, reason: string): void {
    this.metrics.incrementCounter('crm_omni_webhooks_dropped_total', {
      channel: channelType,
      reason,
    });
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
      case 'zalo': {
        if (event?.oa_id) return String(event.oa_id);
        // The OA is the recipient of a user message and the sender of an echo.
        const sentByOa = String(event?.event_name ?? '').startsWith('oa_');
        return String(
          (sentByOa ? event?.sender?.id : event?.recipient?.id) ?? '',
        );
      }
      // The controller unwraps the envelope, so by the time a job reaches here
      // `event` is the inner `event` object and the business account is its
      // recipient. This is the repair path for a job enqueued without an
      // accountId; the controller is the normal source.
      case 'tiktok':
        return String(event?.to_user?.open_id ?? event?.client_key ?? '');
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
  ): string | null {
    const providerMessageId = this.extractProviderMessageId(event);
    // If the provider didn't give us a stable message ID, skip dedup rather
    // than fall back to a transient BullMQ job ID (which changes on retry).
    if (!providerMessageId) return null;

    return `processed:webhook:${channelType}:${
      accountId ?? 'unknown'
    }:${providerMessageId}`;
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
