import { Injectable } from '@nestjs/common';
import { MetricsService } from '../../observability/metrics.service';
import { AutomationActionJobData } from '../queue/automation-queue.constants';

/** Terminal-ish states an action can be recorded in. */
export type ActionOutcome = 'success' | 'failed' | 'retrying';

/** Terminal states an execution can be recorded in. */
export type ExecutionOutcome =
  | 'success'
  | 'failed'
  | 'loop_blocked'
  | 'skipped_run_once';

/**
 * The automation engine's metric surface.
 *
 * Answers the first question anyone asks of an automation platform — what
 * fraction of runs are working — plus throughput, latency and error distribution.
 *
 * Label cardinality: `MetricsService` caps distinct series at 5,000 and drops the
 * rest, so tenant id is NOT a label on the per-action series (tenants × actions ×
 * outcomes would eat the budget and start silently discarding metrics). Tenant
 * attribution is one low-cardinality failure counter, which is what alerting
 * needs to name a noisy tenant.
 */
@Injectable()
export class AutomationMetricsService {
  constructor(private readonly metrics: MetricsService) {}

  recordAction(
    job: Pick<AutomationActionJobData, 'actionType' | 'tenantId'>,
    outcome: ActionOutcome,
    startedAt: Date,
  ): void {
    this.metrics.incrementCounter('crm_automation_action_total', {
      action: job.actionType,
      outcome,
    });
    this.metrics.observeHistogram(
      'crm_automation_action_duration_ms',
      { action: job.actionType },
      Date.now() - startedAt.getTime(),
    );

    if (outcome === 'failed') {
      this.metrics.incrementCounter('crm_automation_action_failed_by_tenant', {
        tenant: job.tenantId,
      });
    }
  }

  recordExecution(outcome: ExecutionOutcome, durationMs?: number): void {
    this.metrics.incrementCounter('crm_automation_execution_total', {
      outcome,
    });
    if (typeof durationMs === 'number') {
      this.metrics.observeHistogram(
        'crm_automation_execution_duration_ms',
        { outcome },
        durationMs,
      );
    }
  }

  recordQueueDepth(queue: string, depth: number): void {
    this.metrics.setGauge('crm_automation_queue_depth', { queue }, depth);
  }

  recordDlq(actionType: string, tenantId: string): void {
    this.metrics.incrementCounter('crm_automation_dlq_total', {
      action: actionType,
    });
    this.metrics.incrementCounter('crm_automation_dlq_by_tenant', {
      tenant: tenantId,
    });
  }

  recordQuotaRejection(kind: string, tenantId: string): void {
    this.metrics.incrementCounter('crm_automation_quota_rejected_total', {
      kind,
      tenant: tenantId,
    });
  }
}
