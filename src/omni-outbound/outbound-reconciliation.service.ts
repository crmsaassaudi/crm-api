import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  OmniMessageDocument,
  OmniMessageSchemaClass,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-message.schema';
import { MetricsService } from '../observability/metrics.service';
import { DeliveryAttemptService } from './delivery-attempt.service';

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1_000;

type StuckMessage = {
  _id: unknown;
  tenantId: unknown;
  conversationId: unknown;
};

/**
 * Recovers outbound messages left in `sending` after a process crash or an
 * indeterminate provider timeout.
 *
 * It deliberately does not resend. Once a provider call has started, absence
 * of a response does not prove absence of delivery. Retrying here could send a
 * duplicate customer message. The future DeliveryCommand/DeliveryAttempt
 * workflow can replace this conservative terminal transition.
 */
@Injectable()
export class OutboundReconciliationService {
  private readonly logger = new Logger(OutboundReconciliationService.name);

  constructor(
    @InjectModel(OmniMessageSchemaClass.name)
    private readonly messages: Model<OmniMessageDocument>,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    private readonly metrics: MetricsService,
    private readonly deliveryAttempts: DeliveryAttemptService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileStuckMessages(): Promise<number> {
    const staleAfterMs = this.positiveInteger(
      this.config.get('OMNI_OUTBOUND_STALE_SENDING_MS'),
      DEFAULT_STALE_AFTER_MS,
    );
    const batchSize = Math.min(
      this.positiveInteger(
        this.config.get('OMNI_OUTBOUND_RECONCILIATION_BATCH_SIZE'),
        DEFAULT_BATCH_SIZE,
      ),
      MAX_BATCH_SIZE,
    );
    const cutoff = new Date(Date.now() - staleAfterMs);

    const candidates = await this.messages
      .find({
        status: 'sending',
        direction: 'outbound',
        updatedAt: { $lte: cutoff },
      })
      .select('_id tenantId conversationId')
      .sort({ updatedAt: 1, _id: 1 })
      .limit(batchSize)
      .lean<StuckMessage[]>()
      .setOptions({ isPlatformQuery: true })
      .exec();

    const reconciledByConversation = new Map<
      string,
      { tenantId: string; messageIds: string[] }
    >();

    for (const candidate of candidates) {
      const result = await this.messages
        .updateOne(
          {
            _id: candidate._id,
            status: 'sending',
            direction: 'outbound',
            updatedAt: { $lte: cutoff },
          },
          {
            $set: {
              status: 'failed',
              'metadata.deliveryReconciliation': {
                reason: 'delivery_outcome_unknown',
                reconciledAt: new Date(),
                staleAfterMs,
              },
            },
          },
        )
        .setOptions({ isPlatformQuery: true })
        .exec();

      if (result.modifiedCount !== 1) continue;

      const tenantId = String(candidate.tenantId);
      const conversationId = String(candidate.conversationId);
      const current = reconciledByConversation.get(conversationId) ?? {
        tenantId,
        messageIds: [],
      };
      current.messageIds.push(String(candidate._id));
      reconciledByConversation.set(conversationId, current);
    }

    let reconciled = 0;
    const reconciledMessageIds: string[] = [];
    for (const [conversationId, group] of reconciledByConversation) {
      reconciled += group.messageIds.length;
      reconciledMessageIds.push(...group.messageIds);
      this.events.emit('livechat.message.status', {
        tenantId: group.tenantId,
        conversationId,
        messageIds: group.messageIds,
        status: 'failed',
      });
    }
    await this.deliveryAttempts.markStartedUnknownForMessages(
      reconciledMessageIds,
    );

    this.metrics.setGauge(
      'crm_omni_outbound_stuck_sending_last_run',
      {},
      candidates.length,
    );
    if (reconciled > 0) {
      this.metrics.incrementCounter(
        'crm_omni_outbound_reconciled_total',
        { outcome: 'delivery_unknown' },
        reconciled,
      );
      this.logger.warn(
        `Marked ${reconciled} stale outbound message(s) as failed with an unknown delivery outcome`,
      );
    }

    return reconciled;
  }

  private positiveInteger(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
