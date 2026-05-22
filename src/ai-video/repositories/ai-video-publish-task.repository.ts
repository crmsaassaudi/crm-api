import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AiVideoPublishTaskSchemaClass,
  AiVideoPublishTaskSchemaDocument,
} from '../infrastructure/persistence/document/entities/ai-video-publish-task.schema';

@Injectable()
export class AiVideoPublishTaskRepository {
  constructor(
    @InjectModel(AiVideoPublishTaskSchemaClass.name)
    private readonly model: Model<AiVideoPublishTaskSchemaDocument>,
  ) {}

  async create(
    data: Record<string, any>,
  ): Promise<AiVideoPublishTaskSchemaClass> {
    return this.model.create(data) as any;
  }

  async findByJobId(
    tenantId: string,
    jobId: string,
  ): Promise<AiVideoPublishTaskSchemaClass | null> {
    return this.model.findOne({ tenantId, jobId }).exec();
  }

  async updateStatus(
    id: string,
    status: string,
    extra?: Partial<AiVideoPublishTaskSchemaClass>,
  ): Promise<AiVideoPublishTaskSchemaClass | null> {
    return this.model
      .findByIdAndUpdate(id, { $set: { status, ...extra } }, { new: true })
      .exec();
  }

  /**
   * Atomically increment retry count and update error details.
   */
  async recordRetry(
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<AiVideoPublishTaskSchemaClass | null> {
    return this.model
      .findByIdAndUpdate(
        id,
        {
          $inc: { retryCount: 1 },
          $set: {
            status: 'FAILED',
            lastErrorCode: errorCode,
            lastErrorMessage: errorMessage,
          },
        },
        { new: true },
      )
      .exec();
  }
}
