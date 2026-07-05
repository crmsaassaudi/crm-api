import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { AssignmentAuditLogSchemaClass } from '../entities/assignment-audit-log.schema';

/**
 * Audit context: the minimal slice of an assignment/reassignment context the
 * audit writer needs. Mirrors the relevant fields of AssignmentContext so this
 * service has no dependency on the engine.
 */
export interface AuditContext {
  tenantId: string;
  module: string;
  entityId?: string;
  attributes?: Record<string, any>;
  /** Side-effect-free dry-run — skip the write (CRIT-06). */
  dryRun?: boolean;
  /** Reassign writes its own row — suppress assign()'s inner write (MED-08). */
  suppressAudit?: boolean;
}

/**
 * AssignmentAuditService — owns the audit-log model and all audit reads/writes.
 *
 * Extracted from AssignmentEngineService (HIGH-01). Centralizes the dry-run /
 * suppress guards and the best-effort write semantics.
 */
@Injectable()
export class AssignmentAuditService {
  private readonly logger = new Logger(AssignmentAuditService.name);

  constructor(
    @InjectModel(AssignmentAuditLogSchemaClass.name)
    private readonly auditLogModel: Model<any>,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

  async getAuditLog(module?: string, entityId?: string) {
    const filter: any = { tenantId: this.tenantId };
    if (module) filter.module = module;
    if (entityId) filter.entityId = entityId;
    return this.auditLogModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()
      .exec();
  }

  async write(
    context: AuditContext,
    data: Partial<AssignmentAuditLogSchemaClass>,
  ): Promise<void> {
    // Centralized guard: dry-run is side-effect-free (CRIT-06) and reassign
    // suppresses assign()'s inner write to avoid duplicate rows (MED-08).
    if (context.dryRun || context.suppressAudit) return;
    try {
      await this.auditLogModel.create({
        tenantId: context.tenantId,
        module: context.module,
        entityId: context.entityId ?? 'pre-create',
        ...data,
        metadata: {
          attributes: context.attributes,
          ...((data as any).metadata || {}),
        },
      });
    } catch (err: any) {
      this.logger.error(`Failed to write audit log: ${err.message}`);
    }
  }
}
