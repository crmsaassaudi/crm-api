import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AutomationDelayedJobData } from '../../../../queue/automation-queue.constants';
import {
  AutomationDelayedJobSchemaClass,
  AutomationDelayedJobStatus,
} from '../entities/automation-delayed-job.schema';

const TERMINAL_RETENTION_DAYS = 30;

@Injectable()
export class AutomationDelayedJobRepository {
  constructor(
    @InjectModel(AutomationDelayedJobSchemaClass.name)
    private readonly model: Model<AutomationDelayedJobSchemaClass>,
  ) {}

  async upsertPending(data: AutomationDelayedJobData, resumeAt: Date) {
    const jobKey = this.buildJobKey(data);

    return this.model
      .findOneAndUpdate(
        { jobKey },
        {
          $setOnInsert: {
            tenantId: data.tenantId,
            jobKey,
            executionId: data.executionId,
            workflowId: data.workflowId,
            resumeFromNodeId: data.resumeFromNodeId,
            recordId: data.recordId,
            recordType: data.recordType,
            payload: data,
            resumeAt,
            status: 'pending',
            enqueuedAt: null,
            processingStartedAt: null,
            completedAt: null,
            failedAt: null,
            enqueueAttempts: 0,
            processAttempts: 0,
            lastError: null,
            expireAt: null,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();
  }

  async claimDueForEnqueue(params: {
    windowUntil: Date;
    staleBefore: Date;
    limit: number;
  }) {
    const claimed: any[] = [];

    for (let index = 0; index < params.limit; index++) {
      const job = await this.model
        .findOneAndUpdate(
          {
            status: { $in: ['pending', 'enqueued'] },
            resumeAt: { $lte: params.windowUntil },
            $or: [
              { status: 'pending' },
              { enqueuedAt: null },
              { enqueuedAt: { $lte: params.staleBefore } },
            ],
          },
          {
            $set: {
              status: 'enqueued',
              enqueuedAt: new Date(),
              lastError: null,
            },
            $inc: { enqueueAttempts: 1 },
          },
          { new: true, sort: { resumeAt: 1 } },
        )
        .setOptions({ isPlatformQuery: true })
        .lean()
        .exec();

      if (!job) break;
      claimed.push(job);
    }

    return claimed;
  }

  async markPendingAfterEnqueueFailure(id: string, message: string) {
    await this.model
      .updateOne(
        { _id: id, status: 'enqueued' },
        {
          $set: {
            status: 'pending',
            enqueuedAt: null,
            lastError: { code: 'REDIS_ENQUEUE_FAILED', message },
          },
        },
      )
      .setOptions({ isPlatformQuery: true })
      .exec();
  }

  async markProcessing(id: string) {
    return this.model
      .findOneAndUpdate(
        { _id: id, status: { $in: ['enqueued', 'processing'] } },
        {
          $set: {
            status: 'processing',
            processingStartedAt: new Date(),
          },
          $inc: { processAttempts: 1 },
        },
        { new: true },
      )
      .lean()
      .exec();
  }

  async markCompleted(id: string) {
    await this.markTerminal(id, 'completed');
  }

  async markFailed(id: string, message: string) {
    await this.markTerminal(id, 'failed', {
      code: 'DELAYED_RESUME_FAILED',
      message,
    });
  }

  async findById(id: string) {
    return this.model.findById(id).lean().exec();
  }

  buildJobKey(data: AutomationDelayedJobData): string {
    return `resume-${data.executionId}-${data.resumeFromNodeId}`;
  }

  private async markTerminal(
    id: string,
    status: Extract<AutomationDelayedJobStatus, 'completed' | 'failed'>,
    error?: { code: string; message: string },
  ) {
    const now = new Date();
    const expireAt = new Date(
      now.getTime() + TERMINAL_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.model
      .updateOne(
        { _id: id },
        {
          $set: {
            status,
            completedAt: status === 'completed' ? now : null,
            failedAt: status === 'failed' ? now : null,
            lastError: error ?? null,
            expireAt,
          },
        },
      )
      .exec();
  }
}
