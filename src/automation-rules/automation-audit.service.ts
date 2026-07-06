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

    const triggerDiff = this.buildTriggerConfigDiff(before, after);
    if (triggerDiff) diffs.push(triggerDiff);

    const nodesDiff = this.buildCountDiff('nodes', before, after);
    if (nodesDiff) diffs.push(nodesDiff);

    const edgesDiff = this.buildCountDiff('edges', before, after);
    if (edgesDiff) diffs.push(edgesDiff);

    return diffs;
  }

  /**
   * Diff the triggerConfig event/object pair.
   * Returns undefined when triggerConfig is absent or unchanged.
   */
  private buildTriggerConfigDiff(
    before: Record<string, any>,
    after: Record<string, any>,
  ): AuditDiffEntry | undefined {
    if (!after.triggerConfig || !before.triggerConfig) return undefined;
    const tc = after.triggerConfig;
    const btc = before.triggerConfig;
    if (tc.event === btc.event && tc.object === btc.object) return undefined;
    return {
      field: 'triggerConfig',
      before: { event: btc.event, object: btc.object },
      after: { event: tc.event, object: tc.object },
    };
  }

  /**
   * Diff a list-type field (nodes/edges) by count only.
   * Returns undefined when the field is absent or the count is unchanged.
   */
  private buildCountDiff(
    field: string,
    before: Record<string, any>,
    after: Record<string, any>,
  ): AuditDiffEntry | undefined {
    if (!after[field] || !before[field]) return undefined;
    const beforeCount = (before[field] ?? []).length;
    const afterCount = (after[field] ?? []).length;
    if (beforeCount === afterCount) return undefined;
    return {
      field,
      before: `${beforeCount} ${field}`,
      after: `${afterCount} ${field}`,
    };
  }
}
