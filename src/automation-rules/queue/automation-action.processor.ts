import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import {
  AUTOMATION_EMAIL_QUEUE,
  AUTOMATION_SMS_QUEUE,
  AUTOMATION_INTERNAL_QUEUE,
  AUTOMATION_WEBHOOK_QUEUE,
  AUTOMATION_ACTION_TYPE_SET,
  AutomationActionJobData,
} from './automation-queue.constants';
import {
  ActionExecutor,
  ActionExecutionResult,
  SendEmailExecutor,
  SendSmsExecutor,
  UpdateFieldExecutor,
  RouteToGroupExecutor,
  WebhookExecutor,
  CreateTaskExecutor,
  CreateTicketExecutor,
  AddTagExecutor,
  RemoveTagExecutor,
  AddNoteExecutor,
  CreateRecordExecutor,
  HttpRequestExecutor,
  SendLivechatExecutor,
  InternalNotificationExecutor,
} from '../engine/executors';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { AutomationDlqProducer } from './automation-dlq.producer';
import { slimOutputForLog } from '../engine/execution-log-redaction';
import { ActionIdempotencyService } from '../engine/action-idempotency.service';
import { ExecutionContextService } from '../engine/execution-context.service';
import { WorkflowOrchestratorService } from '../engine/workflow-orchestrator.service';
import { AutomationMetricsService } from '../observability/automation-metrics.service';
import { AutomationQuotaService } from '../engine/automation-quota.service';

/**
 * Actions billed per message by an external provider, and therefore metered
 * per tenant. Livechat is delivered over the tenant's own widget and is not
 * charged, so it is not counted against a messaging allowance.
 */
const METERED_CHANNEL_BY_ACTION: Record<string, 'email' | 'sms' | undefined> = {
  send_email: 'email',
  send_sms: 'sms',
};

/** Record types an action job may carry. Mirrors AutomationCrmModule. */
const VALID_RECORD_TYPES = new Set([
  'Lead',
  'Contact',
  'Ticket',
  'Deal',
  'Account',
  'Task',
  'Conversation',
  'Message',
]);

/**
 * Shared action processing logic used by all typed queue processors.
 *
 * The orchestrator suspends at an action node; this mixin resumes it. On a
 * terminal outcome — succeeded, or failed with no attempts left — it calls
 * `orchestrator.continueAfterAction()` with the branch that happened. An
 * intermediate retryable failure throws, so BullMQ retries and no branch is taken.
 *
 * A terminal failure returns rather than throws: the DLQ write and the graph
 * continuation belong on one in-band path, not split with BullMQ's `failed`
 * event, which cannot continue a graph.
 */
export class ActionProcessorMixin {
  constructor(
    private readonly executors: Map<string, ActionExecutor>,
    private readonly executionLogRepo: AutomationExecutionLogRepository,
    private readonly dlqProducer: AutomationDlqProducer,
    private readonly logger: Logger,
    private readonly idempotency: ActionIdempotencyService,
    private readonly executionContext: ExecutionContextService,
    private readonly orchestrator: WorkflowOrchestratorService,
    private readonly metrics: AutomationMetricsService,
    private readonly quota: AutomationQuotaService,
  ) {}

  async processAction(job: Job<AutomationActionJobData>): Promise<void> {
    const data = job.data;
    const validationError = this.validateJobData(data);

    if (validationError) {
      const reason = `schema-invalid: ${validationError}`;
      this.logger.error(`[Processor] Job ${job.id} rejected: ${reason}`);
      await this.sendToDlq(data, reason);
      return;
    }

    // BaseTenantConsumer established the tenant; this establishes WHO the action
    // acts as, and with it the data-visibility axes the repository layer reads.
    return this.executionContext.runAs(data.principal, data.workflowId, () =>
      this.runAction(job),
    );
  }

  private validateJobData(data: unknown): string | null {
    if (!this.isRecord(data)) return 'payload must be an object';

    const requiredStrings = [
      'executionId',
      'workflowId',
      'tenantId',
      'nodeId',
      'nodeName',
      'actionType',
      'recordId',
      'recordType',
      'sourceWorkflowId',
      'executionSessionId',
    ];
    for (const field of requiredStrings) {
      if (typeof data[field] !== 'string' || data[field].trim().length === 0) {
        return `${field} is required`;
      }
    }

    if (!/^[0-9a-fA-F]{24}$/.test(data.tenantId as string)) {
      return `tenantId must be a Mongo ObjectId, got "${data.tenantId}"`;
    }
    if (!AUTOMATION_ACTION_TYPE_SET.has(data.actionType as string)) {
      return `unknown actionType "${data.actionType}"`;
    }
    if (!VALID_RECORD_TYPES.has(data.recordType as string)) {
      return `unknown recordType "${data.recordType}"`;
    }
    if (!this.isRecord(data.actionConfig)) {
      return 'actionConfig must be an object';
    }
    if (!this.isRecord(data.recordData)) {
      return 'recordData must be an object';
    }
    if (!this.isRecord(data.principal)) {
      return 'principal is required';
    }
    // The graph is what lets the worker continue the workflow after the action.
    // A job without it cannot resume anything, so it is a schema error, not
    // something to paper over with a re-read of whatever is published now.
    if (
      !Array.isArray(data.publishedNodes) ||
      data.publishedNodes.length === 0
    ) {
      return 'publishedNodes is required';
    }
    if (!Array.isArray(data.publishedEdges)) {
      return 'publishedEdges is required';
    }
    if (
      typeof data.automationDepth !== 'number' ||
      !Number.isInteger(data.automationDepth) ||
      data.automationDepth < 0
    ) {
      return 'automationDepth must be a non-negative integer';
    }
    if (
      data.automationBreadcrumbs !== undefined &&
      (!Array.isArray(data.automationBreadcrumbs) ||
        data.automationBreadcrumbs.some((item) => typeof item !== 'string'))
    ) {
      return 'automationBreadcrumbs must be an array of strings';
    }
    return null;
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private async runAction(job: Job<AutomationActionJobData>): Promise<void> {
    const data = job.data;
    const stepStart = new Date();
    const attempts = job.opts?.attempts ?? 1;
    const isLastAttempt = job.attemptsMade + 1 >= attempts;

    this.logger.log(
      `[Processor] Job ${job.id} | action=${data.actionType} workflow=${data.workflowId} node=${data.nodeId}`,
    );

    // Metered channels are charged before the claim, so a quota rejection does
    // not consume the exactly-once token for a message that was never sent.
    const meteredChannel = METERED_CHANNEL_BY_ACTION[data.actionType];
    if (meteredChannel) {
      const decision = await this.quota.consumeMessage(
        data.tenantId,
        meteredChannel,
      );
      if (!decision.allowed) {
        const error = {
          code: decision.kind ? decision.kind.toUpperCase() : 'QUOTA_EXCEEDED',
          message: decision.reason!,
        };
        if (decision.transient && !isLastAttempt) {
          await this.logActionStep(data, stepStart, { success: false, error });
          throw new Error(decision.reason!);
        }
        await this.logActionStep(data, stepStart, { success: false, error });
        this.metrics.recordAction(data, 'failed', stepStart);
        await this.sendToDlq(data, decision.reason!);
        await this.orchestrator.continueAfterAction(data, 'failure', error);
        return;
      }
    }

    // Exactly-once claim. The deterministic BullMQ jobId only dedupes while the
    // completed job is still in Redis, which at this engine's volumes is
    // seconds — and a redelivered send_email or create_ticket is a second email
    // or a second ticket. Claimed before the executor runs, released below when
    // the failure is retryable.
    if (!(await this.idempotency.claim(data))) {
      this.logger.warn(
        `[Processor] Job ${job.id} skipped — action already executed for ` +
          `execution=${data.executionId} node=${data.nodeId}`,
      );
      return;
    }

    const executor = this.executors.get(data.actionType);
    if (!executor) {
      // A queue receiving an action it has no executor for is a routing bug, not
      // a transient fault. Terminal on the first attempt.
      const message = `Queue has no executor for action type "${data.actionType}"`;
      this.logger.error(`[Processor] ${message}`);
      await this.finishTerminal(data, stepStart, {
        success: false,
        retryable: false,
        error: { code: 'UNKNOWN_ACTION_TYPE', message },
      });
      return;
    }

    const result = await this.runExecutor(executor, data);

    if (result.success) {
      await this.idempotency.confirm(data);
      await this.logActionStep(data, stepStart, result);
      this.metrics.recordAction(data, 'success', stepStart);
      this.logger.log(
        `[Processor] ✅ Action ${data.actionType} completed for node=${data.nodeId}`,
      );
      await this.orchestrator.continueAfterAction(data, 'success');
      return;
    }

    const terminal = result.retryable === false || isLastAttempt;
    if (terminal) {
      await this.finishTerminal(data, stepStart, result);
      return;
    }

    // Retryable and attempts remain: give the claim back or every retry is
    // skipped as a duplicate and the outage looks like success.
    await this.logActionStep(data, stepStart, result);
    this.metrics.recordAction(data, 'retrying', stepStart);
    await this.idempotency.release(data);
    this.logger.warn(
      `[Processor] Action ${data.actionType} failed for node=${data.nodeId} ` +
        `(attempt ${job.attemptsMade + 1}/${attempts}): ${result.error?.message}`,
    );
    throw new Error(result.error?.message ?? 'Action execution failed');
  }

  /**
   * Run the executor, converting a thrown exception into a retryable failure.
   *
   * An exception mid-flight is ambiguous — the side effect may or may not have
   * landed — so it is treated like any other retryable failure rather than
   * escaping into BullMQ's error path, which cannot continue the graph.
   */
  private async runExecutor(
    executor: ActionExecutor,
    data: AutomationActionJobData,
  ): Promise<ActionExecutionResult> {
    try {
      return await executor.execute(data);
    } catch (error: any) {
      this.logger.error(
        `[Processor] Executor ${data.actionType} threw: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: { code: 'EXECUTOR_EXCEPTION', message: error.message },
      };
    }
  }

  /**
   * Terminal failure: keep the claim (nothing will retry automatically), record
   * the step, dead-letter for operator visibility, and continue the graph along
   * the failure branch.
   */
  private async finishTerminal(
    data: AutomationActionJobData,
    stepStart: Date,
    result: ActionExecutionResult,
  ): Promise<void> {
    this.logger.warn(
      `[Processor] Terminal failure for node=${data.nodeId}: ${result.error?.code} — DLQ + failure branch`,
    );
    await this.idempotency.confirm(data);
    await this.logActionStep(data, stepStart, result);
    this.metrics.recordAction(data, 'failed', stepStart);
    await this.sendToDlq(
      data,
      result.error?.message ?? 'Non-retryable failure',
    );
    await this.orchestrator.continueAfterAction(data, 'failure', result.error);
  }

  private async sendToDlq(
    data: AutomationActionJobData,
    reason: string,
  ): Promise<void> {
    await this.dlqProducer
      .sendToDlq(data, reason)
      .catch((dlqErr) =>
        this.logger.error(
          `[Processor] Failed to send to DLQ: ${dlqErr.message}`,
        ),
      );
  }

  /**
   * Log the retry attempts BullMQ handles on its own.
   *
   * Terminal outcomes are dead-lettered in band by `finishTerminal`, so this no
   * longer routes anything to the DLQ — having two producers for the same DLQ
   * entry meant a terminal failure could be recorded twice.
   */
  logRetry(job: Job, error: Error): void {
    const attemptsRemaining = (job.opts?.attempts ?? 1) - job.attemptsMade;
    this.logger.error(
      `Job ${job.id} failed (${Math.max(0, attemptsRemaining)} retries left). ` +
        `Name: ${job.name}. Error: ${error.message}`,
    );
  }

  private async logActionStep(
    data: AutomationActionJobData,
    stepStart: Date,
    result: ActionExecutionResult,
  ): Promise<void> {
    try {
      await this.executionLogRepo.logStep(data.executionId, {
        nodeId: data.nodeId,
        nodeName: data.nodeName,
        nodeType: 'action',
        status: result.success ? 'success' : 'failed',
        input: {
          actionType: data.actionType,
          recordId: data.recordId,
          recordType: data.recordType,
        },
        // Executor outputs echo the recipient back (`to: '+8490…'`), which does
        // not belong in a 30-day log readable with automation_logs:view.
        output: slimOutputForLog(result.output),
        error: result.error
          ? { code: result.error.code, message: result.error.message }
          : undefined,
        startedAt: stepStart,
        completedAt: new Date(),
        duration: Date.now() - stepStart.getTime(),
      });
    } catch (logError: any) {
      this.logger.error(
        `[Processor] Failed to log step for execution=${data.executionId}: ${logError.message}`,
      );
    }
  }
}

/**
 * Worker concurrency for the action queues.
 *
 * BullMQ's default is 1, which meant every DB-only automation action for the
 * whole platform ran one at a time per replica — a queue-shaped bottleneck that
 * looked like "automation is slow" rather than like a setting.
 */
function actionConcurrency(envVar: string, fallback: number): number {
  const parsed = parseInt(process.env[envVar] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Processor(AUTOMATION_EMAIL_QUEUE, {
  concurrency: actionConcurrency('AUTOMATION_EMAIL_CONCURRENCY', 10),
})
export class AutomationEmailProcessor extends BaseTenantConsumer<AutomationActionJobData> {
  protected readonly logger = new Logger(AutomationEmailProcessor.name);
  protected readonly cls: ClsService;
  private readonly mixin: ActionProcessorMixin;

  constructor(
    executionLogRepo: AutomationExecutionLogRepository,
    dlqProducer: AutomationDlqProducer,
    sendEmail: SendEmailExecutor,
    cls: ClsService,
    idempotency: ActionIdempotencyService,
    executionContext: ExecutionContextService,
    orchestrator: WorkflowOrchestratorService,
    metrics: AutomationMetricsService,
    quota: AutomationQuotaService,
  ) {
    super();
    this.cls = cls;
    this.mixin = new ActionProcessorMixin(
      new Map<string, ActionExecutor>([[sendEmail.actionType, sendEmail]]),
      executionLogRepo,
      dlqProducer,
      this.logger,
      idempotency,
      executionContext,
      orchestrator,
      metrics,
      quota,
    );
  }

  @OnWorkerEvent('failed')
  // eslint-disable-next-line @typescript-eslint/require-await
  override async onFailed(job: Job, error: Error) {
    this.mixin.logRetry(job, error);
  }

  protected async handle(job: Job<AutomationActionJobData>): Promise<void> {
    return this.mixin.processAction(job);
  }
}

@Processor(AUTOMATION_SMS_QUEUE, {
  concurrency: actionConcurrency('AUTOMATION_SMS_CONCURRENCY', 10),
})
export class AutomationSmsProcessor extends BaseTenantConsumer<AutomationActionJobData> {
  protected readonly logger = new Logger(AutomationSmsProcessor.name);
  protected readonly cls: ClsService;
  private readonly mixin: ActionProcessorMixin;

  constructor(
    executionLogRepo: AutomationExecutionLogRepository,
    dlqProducer: AutomationDlqProducer,
    sendSms: SendSmsExecutor,
    sendLivechat: SendLivechatExecutor,
    cls: ClsService,
    idempotency: ActionIdempotencyService,
    executionContext: ExecutionContextService,
    orchestrator: WorkflowOrchestratorService,
    metrics: AutomationMetricsService,
    quota: AutomationQuotaService,
  ) {
    super();
    this.cls = cls;
    this.mixin = new ActionProcessorMixin(
      new Map<string, ActionExecutor>([
        [sendSms.actionType, sendSms],
        [sendLivechat.actionType, sendLivechat],
      ]),
      executionLogRepo,
      dlqProducer,
      this.logger,
      idempotency,
      executionContext,
      orchestrator,
      metrics,
      quota,
    );
  }

  @OnWorkerEvent('failed')
  // eslint-disable-next-line @typescript-eslint/require-await
  override async onFailed(job: Job, error: Error) {
    this.mixin.logRetry(job, error);
  }

  protected async handle(job: Job<AutomationActionJobData>): Promise<void> {
    return this.mixin.processAction(job);
  }
}

@Processor(AUTOMATION_INTERNAL_QUEUE, {
  concurrency: actionConcurrency('AUTOMATION_INTERNAL_CONCURRENCY', 20),
})
export class AutomationInternalProcessor extends BaseTenantConsumer<AutomationActionJobData> {
  protected readonly logger = new Logger(AutomationInternalProcessor.name);
  protected readonly cls: ClsService;
  private readonly mixin: ActionProcessorMixin;

  constructor(
    executionLogRepo: AutomationExecutionLogRepository,
    dlqProducer: AutomationDlqProducer,
    updateField: UpdateFieldExecutor,
    routeToGroup: RouteToGroupExecutor,
    createTask: CreateTaskExecutor,
    createTicket: CreateTicketExecutor,
    addTag: AddTagExecutor,
    removeTag: RemoveTagExecutor,
    addNote: AddNoteExecutor,
    createRecord: CreateRecordExecutor,
    internalNotification: InternalNotificationExecutor,
    cls: ClsService,
    idempotency: ActionIdempotencyService,
    executionContext: ExecutionContextService,
    orchestrator: WorkflowOrchestratorService,
    metrics: AutomationMetricsService,
    quota: AutomationQuotaService,
  ) {
    super();
    this.cls = cls;
    this.mixin = new ActionProcessorMixin(
      new Map<string, ActionExecutor>([
        [updateField.actionType, updateField],
        [routeToGroup.actionType, routeToGroup],
        [createTask.actionType, createTask],
        [createTicket.actionType, createTicket],
        [addTag.actionType, addTag],
        [removeTag.actionType, removeTag],
        [addNote.actionType, addNote],
        [createRecord.actionType, createRecord],
        [internalNotification.actionType, internalNotification],
      ]),
      executionLogRepo,
      dlqProducer,
      this.logger,
      idempotency,
      executionContext,
      orchestrator,
      metrics,
      quota,
    );
  }

  @OnWorkerEvent('failed')
  // eslint-disable-next-line @typescript-eslint/require-await
  override async onFailed(job: Job, error: Error) {
    this.mixin.logRetry(job, error);
  }

  protected async handle(job: Job<AutomationActionJobData>): Promise<void> {
    return this.mixin.processAction(job);
  }
}

@Processor(AUTOMATION_WEBHOOK_QUEUE, {
  concurrency: actionConcurrency('AUTOMATION_WEBHOOK_CONCURRENCY', 10),
})
export class AutomationWebhookProcessor extends BaseTenantConsumer<AutomationActionJobData> {
  protected readonly logger = new Logger(AutomationWebhookProcessor.name);
  protected readonly cls: ClsService;
  private readonly mixin: ActionProcessorMixin;

  constructor(
    executionLogRepo: AutomationExecutionLogRepository,
    dlqProducer: AutomationDlqProducer,
    webhook: WebhookExecutor,
    httpRequest: HttpRequestExecutor,
    cls: ClsService,
    idempotency: ActionIdempotencyService,
    executionContext: ExecutionContextService,
    orchestrator: WorkflowOrchestratorService,
    metrics: AutomationMetricsService,
    quota: AutomationQuotaService,
  ) {
    super();
    this.cls = cls;
    this.mixin = new ActionProcessorMixin(
      new Map<string, ActionExecutor>([
        [webhook.actionType, webhook],
        [httpRequest.actionType, httpRequest],
      ]),
      executionLogRepo,
      dlqProducer,
      this.logger,
      idempotency,
      executionContext,
      orchestrator,
      metrics,
      quota,
    );
  }

  @OnWorkerEvent('failed')
  // eslint-disable-next-line @typescript-eslint/require-await
  override async onFailed(job: Job, error: Error) {
    this.mixin.logRetry(job, error);
  }

  protected async handle(job: Job<AutomationActionJobData>): Promise<void> {
    return this.mixin.processAction(job);
  }
}
