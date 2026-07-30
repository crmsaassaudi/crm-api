import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  classifyProviderError,
  ErrorSeverity,
} from '../channels/domain/error-classifier';
import {
  DeliveryAttemptDocument,
  DeliveryAttemptSchemaClass,
} from './infrastructure/delivery-attempt.schema';

@Injectable()
export class DeliveryAttemptService {
  constructor(
    @InjectModel(DeliveryAttemptSchemaClass.name)
    private readonly attempts: Model<DeliveryAttemptDocument>,
  ) {}

  async start(params: {
    tenantId: string;
    messageId: string;
    conversationId: string;
    channelId: string;
    channelType: string;
  }): Promise<string> {
    const attemptId = randomUUID();
    await this.attempts.create({
      ...params,
      attemptId,
      status: 'started',
      startedAt: new Date(),
    });
    return attemptId;
  }

  async succeed(attemptId: string, externalMessageId?: string): Promise<void> {
    await this.attempts
      .updateOne(
        { attemptId, status: 'started' },
        {
          $set: {
            status: 'succeeded',
            completedAt: new Date(),
            externalMessageId: externalMessageId || null,
          },
        },
      )
      .exec();
  }

  async fail(attemptId: string, error: unknown): Promise<'failed' | 'unknown'> {
    const classified = classifyProviderError(error);
    // Transient/network/provider-5xx failures can be indeterminate: the
    // provider may have accepted the message before the response was lost.
    const status =
      classified.severity === ErrorSeverity.TRANSIENT ? 'unknown' : 'failed';

    await this.attempts
      .updateOne(
        { attemptId, status: 'started' },
        {
          $set: {
            status,
            completedAt: new Date(),
            errorCode: classified.code,
            errorSeverity: classified.severity,
            httpStatus: classified.httpStatus ?? null,
            errorMessage: classified.message.substring(0, 2_000),
          },
        },
      )
      .exec();

    return status;
  }

  async markStartedUnknownForMessages(
    messageIds: string[],
    reconciledAt = new Date(),
  ): Promise<number> {
    if (messageIds.length === 0) return 0;

    const result = await this.attempts
      .updateMany(
        { messageId: { $in: messageIds }, status: 'started' },
        {
          $set: {
            status: 'unknown',
            completedAt: reconciledAt,
            errorCode: 'PROCESS_INTERRUPTED',
            errorSeverity: 'transient',
            errorMessage:
              'Delivery process ended before the provider outcome was persisted',
          },
        },
      )
      .setOptions({ isPlatformQuery: true })
      .exec();
    return result.modifiedCount;
  }
}
