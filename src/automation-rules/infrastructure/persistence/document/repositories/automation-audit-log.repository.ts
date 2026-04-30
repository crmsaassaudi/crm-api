import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AutomationAuditLogSchemaClass,
  AuditAction,
  AuditDiffEntry,
  AUDIT_LOG_RETENTION_DAYS,
} from '../entities/automation-audit-log.schema';

@Injectable()
export class AutomationAuditLogRepository {
  constructor(
    @InjectModel(AutomationAuditLogSchemaClass.name)
    private readonly model: Model<AutomationAuditLogSchemaClass>,
  ) {}

  /**
   * Log a workflow lifecycle action for audit purposes.
   */
  async logAction(data: {
    tenantId: string;
    workflowId: string;
    workflowName: string;
    action: AuditAction;
    userId: string;
    diff?: AuditDiffEntry[] | null;
    metadata?: Record<string, any> | null;
  }): Promise<void> {
    const now = new Date();
    const expireAt = new Date(
      now.getTime() + AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.model.create({
      ...data,
      diff: data.diff ?? null,
      metadata: data.metadata ?? null,
      timestamp: now,
      expireAt,
    });
  }

  /**
   * Get audit history for a specific workflow, sorted newest first.
   */
  async findByWorkflow(
    tenantId: string,
    workflowId: string,
    options?: { limit?: number; skip?: number },
  ) {
    return this.model
      .find({ tenantId, workflowId })
      .sort({ timestamp: -1 })
      .skip(options?.skip ?? 0)
      .limit(options?.limit ?? 50)
      .lean()
      .exec();
  }

  /**
   * Get audit activity for a specific user.
   */
  async findByUser(
    tenantId: string,
    userId: string,
    options?: { limit?: number; skip?: number },
  ) {
    return this.model
      .find({ tenantId, userId })
      .sort({ timestamp: -1 })
      .skip(options?.skip ?? 0)
      .limit(options?.limit ?? 50)
      .lean()
      .exec();
  }

  /**
   * Global audit feed for the tenant.
   */
  async findAll(tenantId: string, options?: { limit?: number; skip?: number }) {
    return this.model
      .find({ tenantId })
      .sort({ timestamp: -1 })
      .skip(options?.skip ?? 0)
      .limit(options?.limit ?? 50)
      .lean()
      .exec();
  }
}
