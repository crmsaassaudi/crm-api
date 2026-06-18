import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import {
  AUTOMATION_ACTION_QUEUE,
  AUTOMATION_EMAIL_QUEUE,
  AUTOMATION_SMS_QUEUE,
  AUTOMATION_INTERNAL_QUEUE,
  AUTOMATION_WEBHOOK_QUEUE,
  AutomationActionJobData,
} from './automation-queue.constants';
import {
  ActionExecutor,
  ActionExecutionResult,
  SendEmailExecutor,
  SendSmsExecutor,
  UpdateFieldExecutor,
  RouteToTeamExecutor,
  WebhookExecutor,
  CreateTaskExecutor,
  CreateTicketExecutor,
  AddTagExecutor,
} from '../engine/action-executors';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { AutomationDlqProducer } from './automation-dlq.producer';

/**
 * Shared action processing logic used by all typed queue processors.
 * Extracted to avoid code duplication across 4+ queue consumers.
 *
 * NOTE: CLS tenant context is now set by BaseTenantConsumer.process() —
 * this mixin no longer wraps with runWithTenantContext.
 */
export class ActionProcessorMixin {
  constructor(
    protected readonly executors: Map<string, ActionExecutor>,
    protected readonly executionLogRepo: AutomationExecutionLogRepository,
    protected readonly dlqProducer: AutomationDlqProducer,
    protected readonly logger: Logger,
  ) {}

  async processAction(job: Job<AutomationActionJobData>): Promise<void> {
    const data = job.data;
    const validationError = this.validateJobData(data);

    if (validationError) {
      const reason = `schema-invalid: ${validationError}`;
      this.logger.error(`[Processor] Job ${job.id} rejected: ${reason}`);
      await this.dlqProducer
        .sendToDlq(data as AutomationActionJobData, reason)
        .catch((dlqErr) =>
          this.logger.error(
            `[Processor] Failed to send invalid job ${job.id} to DLQ: ${dlqErr.message}`,
          ),
        );
      return;
    }

    // CLS tenant context is already set by BaseTenantConsumer.process()
    return this.processActionInTenantContext(job);
  }

  private validateJobData(data: unknown): string | null {
    if (!this.isRecord(data)) {
      return 'payload must be an object';
    }

    const requiredStringFields = [
      'executionId',
      'workflowId',
      'tenantId',
      'nodeId',
      'nodeName',
      'actionType',
      'recordId',
      'recordType',
      'sourceWorkflowId',
    ];

    for (const field of requiredStringFields) {
      if (typeof data[field] !== 'string' || data[field].trim().length === 0) {
        return `${field} is required`;
      }
    }

    if (!/^[0-9a-fA-F]{24}$/.test(data.tenantId as string)) {
      return `tenantId must be a Mongo ObjectId, got "${data.tenantId}"`;
    }

    const validActions = new Set([
      'send_email',
      'send_sms',
      'update_field',
      'route_to_team',
      'webhook',
      'create_task',
      'create_ticket',
      'add_tag',
    ]);
    if (!validActions.has(data.actionType as string)) {
      return `unknown actionType "${data.actionType}"`;
    }

    const validRecordTypes = new Set([
      'Lead',
      'Contact',
      'Ticket',
      'Deal',
      'Account',
      'Task',
    ]);
    if (!validRecordTypes.has(data.recordType as string)) {
      return `unknown recordType "${data.recordType}"`;
    }

    if (!this.isRecord(data.actionConfig)) {
      return 'actionConfig must be an object';
    }

    if (!this.isRecord(data.recordData)) {
      return 'recordData must be an object';
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

  private async processActionInTenantContext(
    job: Job<AutomationActionJobData>,
  ): Promise<void> {
    const data = job.data;
    const stepStart = new Date();

    this.logger.log(
      `[Processor] Job ${job.id} | action=${data.actionType} workflow=${data.workflowId} node=${data.nodeId}`,
    );

    const executor = this.executors.get(data.actionType);

    if (!executor) {
      const errorMsg = `Unknown action type: ${data.actionType}`;
      this.logger.error(`[Processor] ${errorMsg}`);

      await this.logActionStep(data, stepStart, {
        success: false,
        error: { code: 'UNKNOWN_ACTION_TYPE', message: errorMsg },
      });

      throw new Error(errorMsg);
    }

    try {
      const result = await executor.execute(data);

      await this.logActionStep(data, stepStart, result);

      if (!result.success) {
        // ── Smart Retry (Phase 2): Non-retryable → DLQ immediately ────
        if (result.retryable === false) {
          this.logger.warn(
            `[Processor] Non-retryable failure for node=${data.nodeId}: ${result.error?.code} — routing to DLQ (skip BullMQ retry)`,
          );
          await this.dlqProducer
            .sendToDlq(data, result.error?.message || 'Non-retryable failure')
            .catch((dlqErr) =>
              this.logger.error(
                `[Processor] Failed to send to DLQ: ${dlqErr.message}`,
              ),
            );
          // Return without throwing — prevents BullMQ from retrying
          return;
        }

        this.logger.warn(
          `[Processor] Action ${data.actionType} failed for node=${data.nodeId}: ${result.error?.message}`,
        );
        throw new Error(result.error?.message || 'Action execution failed');
      }

      this.logger.log(
        `[Processor] ✅ Action ${data.actionType} completed for node=${data.nodeId}`,
      );
    } catch (error: any) {
      // Log if not already logged
      if (!error.message?.startsWith('Action execution failed')) {
        await this.logActionStep(data, stepStart, {
          success: false,
          error: { code: 'EXECUTOR_EXCEPTION', message: error.message },
        });
      }

      throw error; // Re-throw for BullMQ retry
    }
  }

  handleFailedJob(job: Job, error: Error): void {
    const attemptsRemaining = (job.opts?.attempts ?? 3) - job.attemptsMade;

    if (attemptsRemaining <= 0) {
      this.logger.warn(
        `[Processor] Job ${job.id} exhausted all retries — routing to DLQ`,
      );
      this.dlqProducer
        .sendToDlq(job.data, error.message)
        .catch((dlqErr) =>
          this.logger.error(
            `[Processor] Failed to send to DLQ: ${dlqErr.message}`,
          ),
        );
    } else {
      this.logger.error(
        `Job ${job.id} failed (${attemptsRemaining} retries left). Name: ${job.name}. Error: ${error.message}`,
      );
    }
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
        output: result.output,
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

// ─────────────────────────────────────────────────────────────────────────────
// Legacy main queue processor (backward compat)
// ─────────────────────────────────────────────────────────────────────────────

@Processor(AUTOMATION_ACTION_QUEUE)
export class AutomationActionProcessor extends BaseTenantConsumer<AutomationActionJobData> {
  protected readonly logger = new Logger(AutomationActionProcessor.name);
  protected readonly cls: ClsService;
  private readonly mixin: ActionProcessorMixin;

  constructor(
    private readonly executionLogRepo: AutomationExecutionLogRepository,
    private readonly dlqProducer: AutomationDlqProducer,
    sendEmail: SendEmailExecutor,
    sendSms: SendSmsExecutor,
    updateField: UpdateFieldExecutor,
    routeToTeam: RouteToTeamExecutor,
    webhook: WebhookExecutor,
    createTask: CreateTaskExecutor,
    createTicket: CreateTicketExecutor,
    addTag: AddTagExecutor,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
    const executors = new Map<string, ActionExecutor>([
      [sendEmail.actionType, sendEmail],
      [sendSms.actionType, sendSms],
      [updateField.actionType, updateField],
      [routeToTeam.actionType, routeToTeam],
      [webhook.actionType, webhook],
      [createTask.actionType, createTask],
      [createTicket.actionType, createTicket],
      [addTag.actionType, addTag],
    ]);
    this.mixin = new ActionProcessorMixin(
      executors,
      executionLogRepo,
      dlqProducer,
      this.logger,
    );
  }

  @OnWorkerEvent('failed')
  override onFailed(job: Job, error: Error) {
    this.mixin.handleFailedJob(job, error);
  }

  protected async handle(job: Job<AutomationActionJobData>): Promise<void> {
    this.cls.set('executionSource', 'A_F');
    this.cls.set('sourceContext', { flowId: job.data.workflowId });
    return this.mixin.processAction(job);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Email Queue Processor
// ─────────────────────────────────────────────────────────────────────────────

@Processor(AUTOMATION_EMAIL_QUEUE)
export class AutomationEmailProcessor extends BaseTenantConsumer<AutomationActionJobData> {
  protected readonly logger = new Logger(AutomationEmailProcessor.name);
  protected readonly cls: ClsService;
  private readonly mixin: ActionProcessorMixin;

  constructor(
    executionLogRepo: AutomationExecutionLogRepository,
    dlqProducer: AutomationDlqProducer,
    sendEmail: SendEmailExecutor,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
    const executors = new Map<string, ActionExecutor>([
      [sendEmail.actionType, sendEmail],
    ]);
    this.mixin = new ActionProcessorMixin(
      executors,
      executionLogRepo,
      dlqProducer,
      this.logger,
    );
  }

  @OnWorkerEvent('failed')
  override onFailed(job: Job, error: Error) {
    this.mixin.handleFailedJob(job, error);
  }

  protected async handle(job: Job<AutomationActionJobData>): Promise<void> {
    this.cls.set('executionSource', 'A_F');
    this.cls.set('sourceContext', { flowId: job.data.workflowId });
    return this.mixin.processAction(job);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS Queue Processor
// ─────────────────────────────────────────────────────────────────────────────

@Processor(AUTOMATION_SMS_QUEUE)
export class AutomationSmsProcessor extends BaseTenantConsumer<AutomationActionJobData> {
  protected readonly logger = new Logger(AutomationSmsProcessor.name);
  protected readonly cls: ClsService;
  private readonly mixin: ActionProcessorMixin;

  constructor(
    executionLogRepo: AutomationExecutionLogRepository,
    dlqProducer: AutomationDlqProducer,
    sendSms: SendSmsExecutor,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
    const executors = new Map<string, ActionExecutor>([
      [sendSms.actionType, sendSms],
    ]);
    this.mixin = new ActionProcessorMixin(
      executors,
      executionLogRepo,
      dlqProducer,
      this.logger,
    );
  }

  @OnWorkerEvent('failed')
  override onFailed(job: Job, error: Error) {
    this.mixin.handleFailedJob(job, error);
  }

  protected async handle(job: Job<AutomationActionJobData>): Promise<void> {
    this.cls.set('executionSource', 'A_F');
    this.cls.set('sourceContext', { flowId: job.data.workflowId });
    return this.mixin.processAction(job);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Queue Processor (UpdateField + RouteToTeam)
// ─────────────────────────────────────────────────────────────────────────────

@Processor(AUTOMATION_INTERNAL_QUEUE)
export class AutomationInternalProcessor extends BaseTenantConsumer<AutomationActionJobData> {
  protected readonly logger = new Logger(AutomationInternalProcessor.name);
  protected readonly cls: ClsService;
  private readonly mixin: ActionProcessorMixin;

  constructor(
    executionLogRepo: AutomationExecutionLogRepository,
    dlqProducer: AutomationDlqProducer,
    updateField: UpdateFieldExecutor,
    routeToTeam: RouteToTeamExecutor,
    createTask: CreateTaskExecutor,
    createTicket: CreateTicketExecutor,
    addTag: AddTagExecutor,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
    const executors = new Map<string, ActionExecutor>([
      [updateField.actionType, updateField],
      [routeToTeam.actionType, routeToTeam],
      [createTask.actionType, createTask],
      [createTicket.actionType, createTicket],
      [addTag.actionType, addTag],
    ]);
    this.mixin = new ActionProcessorMixin(
      executors,
      executionLogRepo,
      dlqProducer,
      this.logger,
    );
  }

  @OnWorkerEvent('failed')
  override onFailed(job: Job, error: Error) {
    this.mixin.handleFailedJob(job, error);
  }

  protected async handle(job: Job<AutomationActionJobData>): Promise<void> {
    this.cls.set('executionSource', 'A_F');
    this.cls.set('sourceContext', { flowId: job.data.workflowId });
    return this.mixin.processAction(job);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Queue Processor
// ─────────────────────────────────────────────────────────────────────────────

@Processor(AUTOMATION_WEBHOOK_QUEUE)
export class AutomationWebhookProcessor extends BaseTenantConsumer<AutomationActionJobData> {
  protected readonly logger = new Logger(AutomationWebhookProcessor.name);
  protected readonly cls: ClsService;
  private readonly mixin: ActionProcessorMixin;

  constructor(
    executionLogRepo: AutomationExecutionLogRepository,
    dlqProducer: AutomationDlqProducer,
    webhook: WebhookExecutor,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
    const executors = new Map<string, ActionExecutor>([
      [webhook.actionType, webhook],
    ]);
    this.mixin = new ActionProcessorMixin(
      executors,
      executionLogRepo,
      dlqProducer,
      this.logger,
    );
  }

  @OnWorkerEvent('failed')
  override onFailed(job: Job, error: Error) {
    this.mixin.handleFailedJob(job, error);
  }

  protected async handle(job: Job<AutomationActionJobData>): Promise<void> {
    this.cls.set('executionSource', 'A_F');
    this.cls.set('sourceContext', { flowId: job.data.workflowId });
    return this.mixin.processAction(job);
  }
}
