import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AiVideoAuditLogSchemaClass,
  AiVideoAuditLogSchemaDocument,
} from '../infrastructure/persistence/document/entities/ai-video-audit-log.schema';

export interface AuditLogInput {
  tenantId: string;
  jobId: string;
  action: string;
  actorType: 'user' | 'system' | 'worker' | 'ai';
  actorId?: string;
  oldStatus?: string;
  newStatus?: string;
  payload?: Record<string, any>;
  errorMessage?: string;
}

@Injectable()
export class AiVideoAuditLogRepository {
  constructor(
    @InjectModel(AiVideoAuditLogSchemaClass.name)
    private readonly model: Model<AiVideoAuditLogSchemaDocument>,
  ) {}

  async record(input: AuditLogInput): Promise<void> {
    await this.model.create(input);
  }

  async findByJobId(
    tenantId: string,
    jobId: string,
  ): Promise<
    Array<{
      action: string;
      actorType: string;
      actorId?: string;
      oldStatus?: string;
      newStatus?: string;
      payload?: Record<string, any>;
      errorMessage?: string;
      createdAt: Date;
    }>
  > {
    const docs = await this.model
      .find({ tenantId, jobId })
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();

    // Map to plain objects to avoid Mongoose circular refs
    return docs.map((doc: any) => ({
      action: doc.action,
      actorType: doc.actorType,
      actorId: doc.actorId?.toString(),
      oldStatus: doc.oldStatus,
      newStatus: doc.newStatus,
      payload: doc.payload ? { ...doc.payload } : undefined,
      errorMessage: doc.errorMessage,
      createdAt: doc.createdAt,
    }));
  }
}
