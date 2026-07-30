import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import {
  DeliveryCommandDocument,
  DeliveryCommandSchemaClass,
} from './infrastructure/delivery-command.schema';
import { OMNI_DELIVERY_QUEUE } from './delivery-command.constants';
import { MetricsService } from '../observability/metrics.service';

export type DeliveryCommandInput = {
  tenantId: string;
  messageId: string;
  conversationId: string;
  agentId: string;
  content: string;
  messageType: string;
  kind?: 'text' | 'template' | 'interactive' | 'carousel' | 'media' | 'email';
  payload?: Record<string, any>;
  source: string;
  transport: 'http' | 'socket';
  idempotencyKey?: string;
  clientMessageId?: string;
};

@Injectable()
export class DeliveryCommandService {
  private readonly logger = new Logger(DeliveryCommandService.name);

  constructor(
    @InjectModel(DeliveryCommandSchemaClass.name)
    private readonly commands: Model<DeliveryCommandDocument>,
    @InjectQueue(OMNI_DELIVERY_QUEUE) private readonly queue: Queue,
    private readonly metrics: MetricsService,
  ) {}

  async enqueue(input: DeliveryCommandInput): Promise<{
    commandId: string;
    deferred: boolean;
  }> {
    const command = await this.commands
      .findOneAndUpdate(
        { tenantId: input.tenantId, messageId: input.messageId },
        {
          $setOnInsert: {
            ...input,
            kind: input.kind ?? 'text',
            payload: input.payload ?? {},
            status: 'pending',
          },
        },
        { upsert: true, new: true },
      )
      .exec();
    if (!command) throw new Error('Failed to persist delivery command');

    const commandId = String(command._id);
    try {
      await this.addJob(commandId, input.tenantId);
      this.metrics.incrementCounter('crm_omni_delivery_commands_total', {
        outcome: 'queued',
        kind: input.kind ?? 'text',
      });
      return { commandId, deferred: false };
    } catch (error) {
      this.logger.error(
        `Delivery command ${commandId} persisted but enqueue failed; recovery will retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.metrics.incrementCounter('crm_omni_delivery_commands_total', {
        outcome: 'deferred',
        kind: input.kind ?? 'text',
      });
      return { commandId, deferred: true };
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async recoverPending(): Promise<number> {
    const pending = await this.commands
      .find({
        $or: [
          { status: 'pending' },
          {
            status: 'processing',
            processingStartedAt: { $lte: new Date(Date.now() - 5 * 60_000) },
          },
        ],
      })
      .select('_id tenantId status')
      .sort({ updatedAt: 1 })
      .limit(200)
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();

    let recovered = 0;
    for (const command of pending) {
      // A command that reached processing may already have called the
      // provider. Never redeliver it automatically; preserve ambiguity.
      if (command.status === 'processing') {
        const result = await this.commands
          .updateOne(
            { _id: command._id, status: 'processing' },
            {
              $set: {
                status: 'unknown',
                completedAt: new Date(),
                lastError: 'Worker stopped while provider outcome was unknown',
              },
            },
          )
          .setOptions({ isPlatformQuery: true })
          .exec();
        recovered += result.modifiedCount;
        continue;
      }
      try {
        await this.addJob(String(command._id), String(command.tenantId));
        recovered++;
      } catch (error) {
        this.logger.error(
          `Failed to recover delivery command ${String(command._id)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return recovered;
  }

  private addJob(commandId: string, tenantId: string): Promise<unknown> {
    return this.queue.add(
      'deliver-message',
      { commandId, tenantId },
      {
        jobId: commandId,
        attempts: 1,
        removeOnComplete: { count: 1_000, age: 86_400 },
        removeOnFail: { count: 5_000, age: 604_800 },
      },
    );
  }
}
