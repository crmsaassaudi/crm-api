import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import {
  AUTOMATION_TRIGGER_QUEUE,
  AutomationTriggerJobData,
} from './automation-queue.constants';
import { TriggerEvaluatorService } from '../engine/trigger-evaluator.service';
import { AutomationEventPayload } from '../events/automation-event.payload';

/**
 * Evaluates queued CRM events against the tenant's active workflows.
 *
 * This is where trigger matching and DAG traversal now happen. Previously both
 * ran inline on the emitting process, so a user's `PATCH /contacts/:id` paid for
 * every matching workflow's Mongo reads, Redis loop-guard round-trips and
 * execution-log writes on its own event loop after the response was sent — and a
 * process death between the DB commit and the action dispatch lost the automation
 * with nothing recording that it should have run.
 *
 * Concurrency is deliberately separate from the action queues: evaluation is
 * short and IO-bound, actions are rate-limited per provider.
 *
 * @see docs/audit/WORKFLOW_AUTOMATION_SECURITY_AUDIT.md — finding M5
 */
@Processor(AUTOMATION_TRIGGER_QUEUE, {
  concurrency: parseInt(process.env.TRIGGER_QUEUE_CONCURRENCY ?? '10', 10),
})
export class AutomationTriggerProcessor extends BaseTenantConsumer<AutomationTriggerJobData> {
  protected readonly logger = new Logger(AutomationTriggerProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    private readonly evaluator: TriggerEvaluatorService,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<AutomationTriggerJobData>): Promise<void> {
    const data = job.data;

    // Evaluation itself only reads workflows and writes execution logs; the
    // per-workflow principal is resolved inside the orchestrator, because two
    // workflows matching one event can declare different runAs values.
    this.cls.set('executionSource', 'A_F');

    this.logger.log(
      `[Trigger] Evaluating ${data.event}.${data.object} ` +
        `tenant=${data.tenantId} record=${data.recordId} depth=${data.automationDepth ?? 0}`,
    );

    await this.evaluator.evaluate(data as AutomationEventPayload);
  }
}
