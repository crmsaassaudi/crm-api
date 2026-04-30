import { Injectable, Logger } from '@nestjs/common';
import { AutomationAuditLogRepository } from './infrastructure/persistence/document/repositories/automation-audit-log.repository';
import {
  AuditAction,
  AuditDiffEntry,
} from './infrastructure/persistence/document/entities/automation-audit-log.schema';

/**
 * AutomationAuditService — centralized audit logging for workflow lifecycle events.
 *
 * Every Create, Update, Publish, Status Toggle, Delete, and Duplicate action
 * is logged with the acting user, a timestamp, and a diff of what changed.
 */
@Injectable()
export class AutomationAuditService {
  private readonly logger = new Logger(AutomationAuditService.name);

  constructor(private readonly auditRepo: AutomationAuditLogRepository) {}

  /**
   * Log a workflow lifecycle action.
   */
  async logAction(params: {
    tenantId: string;
    userId: string;
    workflowId: string;
    workflowName: string;
    action: AuditAction;
    diff?: AuditDiffEntry[] | null;
    metadata?: Record<string, any> | null;
  }): Promise<void> {
    try {
      await this.auditRepo.logAction(params);
      this.logger.debug(
        `[Audit] ${params.action} workflow="${params.workflowName}" by user=${params.userId}`,
      );
    } catch (error: any) {
      // Audit logging should never block the main operation
      this.logger.error(
        `[Audit] Failed to log ${params.action}: ${error.message}`,
      );
    }
  }

  /**
   * Compute a shallow diff between the old and new workflow state.
   * For nodes/edges, tracks count changes rather than deep object diff.
   */
  computeDiff(
    before: Record<string, any> | null,
    after: Record<string, any>,
  ): AuditDiffEntry[] {
    if (!before) return [];

    const diffsToTrack = ['name', 'description', 'status'];
    const diffs: AuditDiffEntry[] = [];

    for (const field of diffsToTrack) {
      if (before[field] !== after[field] && after[field] !== undefined) {
        diffs.push({
          field,
          before: before[field],
          after: after[field],
        });
      }
    }

    // Trigger config changes
    if (after.triggerConfig && before.triggerConfig) {
      const tc = after.triggerConfig;
      const btc = before.triggerConfig;
      if (tc.event !== btc.event || tc.object !== btc.object) {
        diffs.push({
          field: 'triggerConfig',
          before: { event: btc.event, object: btc.object },
          after: { event: tc.event, object: tc.object },
        });
      }
    }

    // Nodes — track count change
    if (after.nodes && before.nodes) {
      const beforeCount = (before.nodes || []).length;
      const afterCount = (after.nodes || []).length;
      if (beforeCount !== afterCount) {
        diffs.push({
          field: 'nodes',
          before: `${beforeCount} nodes`,
          after: `${afterCount} nodes`,
        });
      }
    }

    // Edges — track count change
    if (after.edges && before.edges) {
      const beforeCount = (before.edges || []).length;
      const afterCount = (after.edges || []).length;
      if (beforeCount !== afterCount) {
        diffs.push({
          field: 'edges',
          before: `${beforeCount} edges`,
          after: `${afterCount} edges`,
        });
      }
    }

    return diffs;
  }
}
