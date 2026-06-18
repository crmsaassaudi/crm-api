import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { AutomationActionJobData } from '../queue/automation-queue.constants';
import { TemplateInterpolationService } from './template-interpolation.service';
import { CrmRecordUpdateService } from './crm-record-update.service';
import { SsrfGuardService } from './ssrf-guard.service';
import {
  EmailProviderService,
  EMAIL_PROVIDER_TOKEN,
} from './providers/email-provider.service';
import {
  SmsProviderService,
  SMS_PROVIDER_TOKEN,
} from './providers/sms-provider.service';
import { AssignmentEngineService } from '../../assignment-engine/assignment-engine.service';
import { ChannelConfigRepository } from '../../channels/infrastructure/persistence/document/repositories/channel-config.repository';
import {
  ICryptoService,
  CRYPTO_SERVICE_TOKEN,
} from '../../channels/domain/crypto.service';
import {
  classifyProviderError,
  ErrorSeverity,
} from '../../channels/domain/error-classifier';
import { TransportPoolService } from '../../channels/transport-pool.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WebhookHeaderCryptoService } from './webhook-header-crypto.service';
import { TasksService } from '../../tasks/tasks.service';
import { TicketsService } from '../../tickets/tickets.service';

/**
 * Base interface for all action executors.
 * Each executor handles one action type (email, sms, update_field, route, webhook).
 */
export interface ActionExecutor {
  readonly actionType: string;
  execute(job: AutomationActionJobData): Promise<ActionExecutionResult>;
}

export interface ActionExecutionResult {
  success: boolean;
  output?: Record<string, any>;
  error?: { code: string; message: string };
  /**
   * Phase 2 Smart Retry: If explicitly false, BullMQ should NOT retry this job.
   * It will be sent directly to the DLQ.
   * Undefined/true = normal BullMQ retry behavior.
   */
  retryable?: boolean;
}

// ---------------------------------------------------------------------------
// Send Email Executor
// ---------------------------------------------------------------------------

@Injectable()
export class SendEmailExecutor implements ActionExecutor {
  readonly actionType = 'send_email';
  private readonly logger = new Logger(SendEmailExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    @Inject(EMAIL_PROVIDER_TOKEN)
    private readonly emailProvider: EmailProviderService,
    @Optional() private readonly channelConfigRepo?: ChannelConfigRepository,
    @Optional()
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto?: ICryptoService,
    @Optional() private readonly transportPool?: TransportPoolService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordData, actionConfig, tenantId, recordType } = job;

    // -- Polymorphic Task Support --
    // Tasks don't have email directly. Resolve from parent entity.
    let to = recordData.emails?.[0] || recordData.email;
    if (!to && recordType === 'Task') {
      to =
        recordData.contactEmail ||
        recordData.accountEmail ||
        recordData.relatedContact?.email ||
        recordData.relatedAccount?.emails?.[0];
      if (to) {
        this.logger.log(
          `[SendEmail] Resolved email from parent entity for Task ${recordId}: ${to}`,
        );
      }
    }

    if (!to) {
      return {
        success: false,
        error: {
          code: 'NO_EMAIL',
          message: `Record ${recordId} (${recordType}) has no email address`,
        },
      };
    }

    // -- Template Interpolation with null-safe fallback --
    const subject = this.templateEngine.interpolate(
      actionConfig.subject || '',
      recordData,
      {
        fallbackMap: { Name: 'Valued Customer', firstName: 'Valued Customer' },
      },
    );
    const body = this.templateEngine.interpolate(
      actionConfig.template || '',
      recordData,
      {
        fallbackMap: { Name: 'Valued Customer', firstName: 'Valued Customer' },
      },
    );

    this.logger.log(
      `[SendEmail] tenant=${tenantId} to=${to} subject="${subject}"`,
    );

    // -- Send via dynamic config or fallback env-based provider --
    const configId = actionConfig.configId;
    if (configId) {
      try {
        // P0: Transport Pool (LRU Cache)
        // Cache hit: ~0.01ms | Cache miss: DB + decrypt (~50ms)
        const transport = this.transportPool
          ? await this.transportPool.resolve(configId)
          : await this.fallbackResolve(configId, tenantId);

        if (!transport) {
          return {
            success: false,
            retryable: false,
            error: {
              code: 'CHANNEL_CONFIG_NOT_FOUND',
              message: `Channel config ${configId} not found or deleted. Please update the workflow.`,
            },
          };
        }

        // Pre-flight Guard: skip execution if config is in error state
        if (transport.status === 'error') {
          this.logger.warn(
            `[SendEmail] Pre-flight SKIP: config "${transport.name}" is in error state - routing to DLQ`,
          );
          return {
            success: false,
            retryable: false,
            error: {
              code: 'CONFIG_SUSPENDED',
              message:
                `Channel config "${transport.name}" is in error state (credentials may be invalid). ` +
                `Fix the config in Settings > Channel Config, then retry from DLQ.`,
            },
          };
        }

        const fromEmail =
          transport.publicSettings?.fromEmail || 'noreply@example.com';
        const fromName = transport.publicSettings?.fromName || 'CRM';

        this.logger.log(
          `[SendEmail] Using dynamic config "${transport.name}" (${transport.providerType}) from=${fromEmail}`,
        );

        const result = await this.emailProvider.send({
          to,
          subject,
          body,
          fromEmail,
          fromName,
        });

        // Smart Retry: classify errors from provider
        if (!result.success && result.error) {
          const classified = classifyProviderError({
            message: result.error.message,
            code: result.error.code,
          });

          if (classified.severity === ErrorSeverity.PERMANENT) {
            this.logger.warn(
              `[SendEmail] PERMANENT error for config "${transport.name}": ${classified.code} - dropping to DLQ`,
            );

            if (classified.shouldUpdateConfigStatus && this.channelConfigRepo) {
              await this.channelConfigRepo.updateHealthStatus(configId, {
                status: 'error',
                lastHealthError: classified.message,
                consecutiveFailures: (transport.consecutiveFailures || 0) + 1,
              });

              // P1: Passive trigger - schedule fast-lane adaptive health check
              this.eventEmitter?.emit('channel-config.runtime-failure', {
                configId,
                tenantId: transport.tenantId,
                httpStatus: classified.httpStatus,
              });
            }

            return { ...result, retryable: false };
          }
          this.logger.log(
            `[SendEmail] TRANSIENT error: ${classified.code} - BullMQ will retry`,
          );
        }

        return result;
      } catch (err: any) {
        this.logger.error(
          `[SendEmail] Dynamic config error: ${err.message}`,
          err.stack,
        );

        const classified = classifyProviderError(err);
        return {
          success: false,
          retryable: classified.severity === ErrorSeverity.TRANSIENT,
          error: { code: classified.code, message: classified.message },
        };
      }
    }

    // Fallback: env-based provider
    return this.emailProvider.send({ to, subject, body });
  }

  /** Fallback: resolve without pool (backward compat when TransportPool not injected) */
  private async fallbackResolve(configId: string, tenantId: string) {
    if (!this.channelConfigRepo || !this.crypto) return null;
    const config =
      await this.channelConfigRepo.findByIdWithCredentialsNoTenant(configId);
    if (!config?.encryptedCredentials) return null;
    if (config.tenantId !== tenantId) return null;
    const credentials = JSON.parse(
      await this.crypto.decrypt(config.encryptedCredentials),
    );
    return {
      configId: config.id,
      tenantId: config.tenantId,
      providerType: config.providerType,
      name: config.name,
      status: config.status,
      healthState: (config as any).healthState || 'healthy',
      credentials,
      publicSettings: config.publicSettings || {},
      consecutiveFailures: config.consecutiveFailures || 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Send SMS Executor
// ---------------------------------------------------------------------------

@Injectable()
export class SendSmsExecutor implements ActionExecutor {
  readonly actionType = 'send_sms';
  private readonly logger = new Logger(SendSmsExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    @Inject(SMS_PROVIDER_TOKEN)
    private readonly smsProvider: SmsProviderService,
    @Optional() private readonly smsChannelConfigRepo?: ChannelConfigRepository,
    @Optional()
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly smsCrypto?: ICryptoService,
    @Optional() private readonly smsTransportPool?: TransportPoolService,
    @Optional() private readonly smsEventEmitter?: EventEmitter2,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordData, actionConfig, tenantId, recordType } = job;

    // -- Polymorphic Task Support --
    // Tasks don't have phone directly. Resolve from parent entity.
    let phone = recordData.phones?.[0] || recordData.phone;
    if (!phone && recordType === 'Task') {
      phone =
        recordData.contactPhone ||
        recordData.accountPhone ||
        recordData.relatedContact?.phone ||
        recordData.relatedAccount?.phones?.[0];
      if (phone) {
        this.logger.log(
          `[SendSMS] Resolved phone from parent entity for Task ${recordId}: ${phone}`,
        );
      }
    }

    if (!phone) {
      return {
        success: false,
        error: {
          code: 'NO_PHONE',
          message: `Record ${recordId} (${recordType}) has no phone number`,
        },
      };
    }

    // -- Template Interpolation --
    const message = this.templateEngine.interpolate(
      actionConfig.message || '',
      recordData,
      {
        fallbackMap: { Name: 'Valued Customer', firstName: 'Valued Customer' },
      },
    );

    if (message.length > 160) {
      this.logger.warn(
        `[SendSMS] Message exceeds 160 chars (${message.length}) for record ${recordId}`,
      );
    }

    this.logger.log(
      `[SendSMS] tenant=${tenantId} to=${phone} chars=${message.length}`,
    );

    // -- Send via dynamic config or fallback env-based provider --
    const configId = actionConfig.configId;
    if (configId) {
      try {
        // P0: Transport Pool (LRU Cache) - same pattern as SendEmailExecutor
        const transport = this.smsTransportPool
          ? await this.smsTransportPool.resolve(configId)
          : await this.smsFallbackResolve(configId, tenantId);

        if (!transport) {
          return {
            success: false,
            retryable: false,
            error: {
              code: 'CHANNEL_CONFIG_NOT_FOUND',
              message: `Channel config ${configId} not found or deleted. Please update the workflow.`,
            },
          };
        }

        // Pre-flight Guard: skip execution if config is in error state
        if (transport.status === 'error') {
          this.logger.warn(
            `[SendSMS] Pre-flight SKIP: config "${transport.name}" is in error state - routing to DLQ`,
          );
          return {
            success: false,
            retryable: false,
            error: {
              code: 'CONFIG_SUSPENDED',
              message:
                `Channel config "${transport.name}" is in error state (credentials may be invalid). ` +
                `Fix the config in Settings > Channel Config, then retry from DLQ.`,
            },
          };
        }

        const fromNumber = transport.publicSettings?.fromNumber;

        this.logger.log(
          `[SendSMS] Using dynamic config "${transport.name}" (${transport.providerType}) from=${fromNumber}`,
        );

        // Dynamic send - route through the injected provider
        const result = await this.smsProvider.send({
          to: phone,
          message,
          fromNumber,
        });

        // Smart Retry: classify errors from provider
        if (!result.success && result.error) {
          const classified = classifyProviderError({
            message: result.error.message,
            code: result.error.code,
          });

          if (classified.severity === ErrorSeverity.PERMANENT) {
            this.logger.warn(
              `[SendSMS] PERMANENT error for config "${transport.name}": ${classified.code} - dropping to DLQ`,
            );

            if (
              classified.shouldUpdateConfigStatus &&
              this.smsChannelConfigRepo
            ) {
              await this.smsChannelConfigRepo.updateHealthStatus(configId, {
                status: 'error',
                lastHealthError: classified.message,
                consecutiveFailures: (transport.consecutiveFailures || 0) + 1,
              });

              // P1: Passive trigger - schedule fast-lane adaptive health check
              this.smsEventEmitter?.emit('channel-config.runtime-failure', {
                configId,
                tenantId: transport.tenantId,
                httpStatus: classified.httpStatus,
              });
            }

            return { ...result, retryable: false };
          }

          this.logger.log(
            `[SendSMS] TRANSIENT error: ${classified.code} - BullMQ will retry`,
          );
        }

        return result;
      } catch (err: any) {
        this.logger.error(
          `[SendSMS] Dynamic config error: ${err.message}`,
          err.stack,
        );

        const classified = classifyProviderError(err);
        return {
          success: false,
          retryable: classified.severity === ErrorSeverity.TRANSIENT,
          error: { code: classified.code, message: classified.message },
        };
      }
    }

    // Fallback: env-based provider
    return this.smsProvider.send({ to: phone, message });
  }

  /** Fallback: resolve without pool (backward compat when TransportPool not injected) */
  private async smsFallbackResolve(configId: string, tenantId: string) {
    if (!this.smsChannelConfigRepo || !this.smsCrypto) return null;
    const config =
      await this.smsChannelConfigRepo.findByIdWithCredentialsNoTenant(configId);
    if (!config?.encryptedCredentials) return null;
    if (config.tenantId !== tenantId) return null;
    const credentials = JSON.parse(
      await this.smsCrypto.decrypt(config.encryptedCredentials),
    );
    return {
      configId: config.id,
      tenantId: config.tenantId,
      providerType: config.providerType,
      name: config.name,
      status: config.status,
      healthState: (config as any).healthState || 'healthy',
      credentials,
      publicSettings: config.publicSettings || {},
      consecutiveFailures: config.consecutiveFailures || 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Update Field Executor
// ---------------------------------------------------------------------------

@Injectable()
export class UpdateFieldExecutor implements ActionExecutor {
  readonly actionType = 'update_field';
  private readonly logger = new Logger(UpdateFieldExecutor.name);

  constructor(private readonly crmUpdate: CrmRecordUpdateService) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId } = job;
    const field = actionConfig.targetField;
    const value = actionConfig.targetValue;

    if (!field) {
      return {
        success: false,
        error: { code: 'NO_FIELD', message: 'targetField is required' },
      };
    }

    this.logger.log(
      `[UpdateField] tenant=${tenantId} ${recordType}(${recordId}).${field} = "${value}"`,
    );

    // Call CRM service to update the record
    const result = await this.crmUpdate.updateField({
      tenantId,
      recordType,
      recordId,
      field,
      value,
      sourceWorkflowId: job.sourceWorkflowId,
      automationDepth: job.automationDepth,
      automationBreadcrumbs: job.automationBreadcrumbs,
    });

    if (!result.success) {
      return {
        success: false,
        error: {
          code: 'UPDATE_FIELD_FAILED',
          message:
            result.error ||
            `Failed to update ${recordType}(${recordId}).${field}`,
        },
      };
    }

    return {
      success: true,
      output: {
        recordType,
        recordId,
        field,
        previousValue: result.previousValue,
        newValue: result.newValue,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Route to Team Executor
// ---------------------------------------------------------------------------

@Injectable()
export class RouteToTeamExecutor implements ActionExecutor {
  readonly actionType = 'route_to_team';
  private readonly logger = new Logger(RouteToTeamExecutor.name);

  constructor(
    private readonly assignmentEngine: AssignmentEngineService,
    private readonly crmUpdate: CrmRecordUpdateService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId } = job;
    const teamId = actionConfig.teamId;
    const userId = actionConfig.userId;

    if (!teamId && !userId) {
      return {
        success: false,
        error: { code: 'NO_TARGET', message: 'teamId or userId is required' },
      };
    }

    this.logger.log(
      `[RouteToTeam] tenant=${tenantId} ${recordType}(${recordId}) > team=${teamId || 'N/A'} user=${userId || 'round-robin'}`,
    );

    // Direct user assignment (skip assignment engine)
    if (userId) {
      const result = await this.crmUpdate.updateField({
        tenantId,
        recordType,
        recordId,
        field: 'ownerId',
        value: userId,
        sourceWorkflowId: job.sourceWorkflowId,
        automationDepth: job.automationDepth,
        automationBreadcrumbs: job.automationBreadcrumbs,
      });

      if (!result.success) {
        return {
          success: false,
          error: {
            code: 'ROUTE_FAILED',
            message:
              result.error ||
              `Failed to assign ${recordType}(${recordId}) to user ${userId}`,
          },
        };
      }

      return {
        success: true,
        output: {
          recordType,
          recordId,
          assignedUser: userId,
          strategy: 'direct',
        },
      };
    }

    // Team-based assignment via AssignmentEngine (round-robin)
    try {
      const assignResult = await this.assignmentEngine.assign({
        module: recordType as any,
        tenantId,
        entityId: recordId,
        attributes: job.recordData,
      });

      if (!assignResult.ownerId) {
        return {
          success: false,
          error: {
            code: 'NO_ELIGIBLE_AGENT',
            message:
              assignResult.reason ||
              `No eligible agent found for team ${teamId}`,
          },
        };
      }

      // Update the ownerId on the record
      const updateResult = await this.crmUpdate.updateField({
        tenantId,
        recordType,
        recordId,
        field: 'ownerId',
        value: assignResult.ownerId,
        sourceWorkflowId: job.sourceWorkflowId,
        automationDepth: job.automationDepth,
        automationBreadcrumbs: job.automationBreadcrumbs,
      });

      if (!updateResult.success) {
        return {
          success: false,
          error: {
            code: 'ROUTE_UPDATE_FAILED',
            message:
              updateResult.error || 'Failed to update ownerId after assignment',
          },
        };
      }

      return {
        success: true,
        output: {
          recordType,
          recordId,
          assignedTeam: teamId,
          assignedUser: assignResult.ownerId,
          strategy: assignResult.strategy,
          reason: assignResult.reason,
        },
      };
    } catch (error: any) {
      this.logger.error(
        `[RouteToTeam] AssignmentEngine error: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: {
          code: 'ASSIGNMENT_ENGINE_ERROR',
          message: error.message,
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook Executor
// ---------------------------------------------------------------------------

/**
 * Hard timeout cap for webhook requests (milliseconds).
 * Exceeding this results in AbortError, then WEBHOOK_TIMEOUT, retry, then DLQ.
 */
const WEBHOOK_HARD_TIMEOUT_MS = 5000;

@Injectable()
export class WebhookExecutor implements ActionExecutor {
  readonly actionType = 'webhook';
  private readonly logger = new Logger(WebhookExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    private readonly ssrfGuard: SsrfGuardService,
    private readonly webhookHeaderCrypto: WebhookHeaderCryptoService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { actionConfig, recordData, tenantId } = job;
    const url = actionConfig.webhookUrl;
    const method = (actionConfig.method || 'POST').toUpperCase();
    const timeout = Math.min(
      actionConfig.timeout || WEBHOOK_HARD_TIMEOUT_MS,
      WEBHOOK_HARD_TIMEOUT_MS,
    ); // Hard cap 5s

    if (!url) {
      return {
        success: false,
        error: { code: 'NO_WEBHOOK_URL', message: 'webhookUrl is required' },
      };
    }

    // SSRF Guard
    const ssrfCheck = await this.ssrfGuard.validate(url);
    if (!ssrfCheck.safe) {
      this.logger.warn(`[Webhook] SSRF BLOCKED: ${url} - ${ssrfCheck.reason}`);
      return {
        success: false,
        error: { code: 'SSRF_BLOCKED', message: ssrfCheck.reason! },
      };
    }

    // DNS Pinning: connect to the pre-verified IP to prevent DNS rebinding.
    // The original hostname travels as the Host header so the server routes correctly.
    let fetchUrl = url;
    const pinnedHeaders: Record<string, string> = {};
    if (ssrfCheck.resolvedIp) {
      const parsedUrl = new URL(url);
      const originalHost = parsedUrl.host;
      const ipLiteral = ssrfCheck.resolvedIp.includes(':')
        ? `[${ssrfCheck.resolvedIp}]`
        : ssrfCheck.resolvedIp;
      parsedUrl.hostname = ipLiteral;
      fetchUrl = parsedUrl.toString();
      pinnedHeaders['Host'] = originalHost;
    }

    // Interpolate body template
    let bodyStr: string;
    if (actionConfig.bodyTemplate) {
      bodyStr = this.templateEngine.interpolate(
        actionConfig.bodyTemplate,
        recordData,
      );
    } else {
      // Default: send full record data as JSON
      bodyStr = JSON.stringify(recordData);
    }

    this.logger.log(
      `[Webhook] tenant=${tenantId} ${method} ${url} bodyLength=${bodyStr.length} timeout=${timeout}ms`,
    );

    // HTTP Request with hard timeout
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const headers =
        await this.webhookHeaderCrypto.resolveHeadersForExecution(actionConfig);

      const fetchOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...pinnedHeaders, // DNS-pinned Host overrides any user-supplied Host
        },
        signal: controller.signal,
      };

      // Only attach body for non-GET requests
      if (method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = bodyStr;
      }

      const response = await fetch(fetchUrl, fetchOptions);

      if (!response.ok) {
        // Read body BEFORE clearing the timer: a Slowloris server could stall
        // body delivery indefinitely if the abort timer is cancelled too early.
        const responseBody = await response.text().catch(() => '(unreadable)');
        clearTimeout(timer);
        return {
          success: false,
          error: {
            code: 'WEBHOOK_HTTP_ERROR',
            message: `HTTP ${response.status} ${response.statusText}: ${responseBody.substring(0, 200)}`,
          },
        };
      }

      clearTimeout(timer);
      return {
        success: true,
        output: {
          status: response.status,
          statusText: response.statusText,
          url,
          method,
        },
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        this.logger.warn(`[Webhook] TIMEOUT after ${timeout}ms: ${url}`);
        return {
          success: false,
          error: {
            code: 'WEBHOOK_TIMEOUT',
            message: `Webhook request to ${url} timed out after ${timeout}ms`,
          },
        };
      }

      this.logger.error(
        `[Webhook] Request failed: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: {
          code: 'WEBHOOK_ERROR',
          message: error.message,
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Create Task Executor
// ---------------------------------------------------------------------------

@Injectable()
export class CreateTaskExecutor implements ActionExecutor {
  readonly actionType = 'create_task';
  private readonly logger = new Logger(CreateTaskExecutor.name);

  constructor(
    private readonly tasksService: TasksService,
    private readonly templateEngine: TemplateInterpolationService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const title = this.templateEngine.interpolate(
      actionConfig.title || 'Follow up',
      recordData,
      { fallbackMap: { firstName: 'Customer', Name: 'Customer' } },
    );

    const dueDateRaw = actionConfig.dueDateOffsetDays
      ? new Date(
          Date.now() + Number(actionConfig.dueDateOffsetDays) * 86_400_000,
        )
      : actionConfig.dueDate
        ? new Date(actionConfig.dueDate)
        : new Date(Date.now() + 86_400_000); // default: tomorrow

    this.logger.log(
      `[CreateTask] tenant=${tenantId} title="${title}" dueDate=${dueDateRaw.toISOString()} triggeredBy=${recordType}(${recordId})`,
    );

    try {
      const task = await this.tasksService.create({
        title,
        description: actionConfig.description
          ? this.templateEngine.interpolate(
              actionConfig.description,
              recordData,
            )
          : undefined,
        dueDate: dueDateRaw,
        priority: actionConfig.priority || 'MEDIUM',
        ownerId: actionConfig.assigneeId || recordData.ownerId,
        categoryId: actionConfig.categoryId,
        relatedTo: {
          type: recordType,
          id: recordId,
          name:
            recordData.name ||
            recordData.title ||
            recordData.subject ||
            recordData.firstName ||
            recordId,
        },
        tags: actionConfig.tags,
      } as any);

      this.logger.log(
        `[CreateTask] ✅ Created task ${task.id} linked to ${recordType}(${recordId})`,
      );

      return {
        success: true,
        output: { taskId: task.id, title: task.title },
      };
    } catch (err: any) {
      this.logger.error(`[CreateTask] Failed: ${err.message}`, err.stack);
      return {
        success: false,
        error: { code: 'CREATE_TASK_FAILED', message: err.message },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Create Ticket Executor
// ---------------------------------------------------------------------------

@Injectable()
export class CreateTicketExecutor implements ActionExecutor {
  readonly actionType = 'create_ticket';
  private readonly logger = new Logger(CreateTicketExecutor.name);

  constructor(
    private readonly ticketsService: TicketsService,
    private readonly templateEngine: TemplateInterpolationService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const subject = this.templateEngine.interpolate(
      actionConfig.subject || 'Support Request',
      recordData,
      { fallbackMap: { firstName: 'Customer', Name: 'Customer' } },
    );

    // Resolve contactId from trigger record
    const contactId =
      actionConfig.contactId ||
      (recordType === 'Contact' ? recordId : recordData.contactId) ||
      undefined;

    // Resolve omniConversationId if triggered from a Conversation
    const omniConversationId =
      actionConfig.omniConversationId ||
      (recordType === 'Conversation'
        ? recordId
        : recordData.omniConversationId) ||
      undefined;

    this.logger.log(
      `[CreateTicket] tenant=${tenantId} subject="${subject}" contactId=${contactId} triggeredBy=${recordType}(${recordId})`,
    );

    try {
      const ticket = await this.ticketsService.create({
        subject,
        description: actionConfig.description
          ? this.templateEngine.interpolate(
              actionConfig.description,
              recordData,
            )
          : undefined,
        priority: actionConfig.priority || 'MEDIUM',
        statusId: actionConfig.statusId,
        typeId: actionConfig.typeId,
        sourceId: actionConfig.sourceId,
        ownerId: actionConfig.assigneeId || recordData.ownerId,
        groupId: actionConfig.groupId,
        contactId,
        accountId: recordData.accountId,
        omniConversationId,
        tags: actionConfig.tags,
      } as any);

      this.logger.log(
        `[CreateTicket] ✅ Created ticket ${ticket.id} (${ticket.ticketNumber}) for contact=${contactId}`,
      );

      return {
        success: true,
        output: {
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          subject: ticket.subject,
        },
      };
    } catch (err: any) {
      this.logger.error(`[CreateTicket] Failed: ${err.message}`, err.stack);
      return {
        success: false,
        error: { code: 'CREATE_TICKET_FAILED', message: err.message },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Add Tag Executor
// ---------------------------------------------------------------------------

@Injectable()
export class AddTagExecutor implements ActionExecutor {
  readonly actionType = 'add_tag';
  private readonly logger = new Logger(AddTagExecutor.name);

  constructor(private readonly crmUpdate: CrmRecordUpdateService) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const rawTags: string[] = Array.isArray(actionConfig.tags)
      ? actionConfig.tags
      : typeof actionConfig.tags === 'string'
        ? actionConfig.tags
            .split(',')
            .map((t: string) => t.trim())
            .filter(Boolean)
        : [];

    if (rawTags.length === 0) {
      return {
        success: false,
        error: { code: 'NO_TAGS', message: 'actionConfig.tags is required' },
      };
    }

    this.logger.log(
      `[AddTag] tenant=${tenantId} ${recordType}(${recordId}) += [${rawTags.join(', ')}]`,
    );

    // Merge new tags with existing tags (deduplication)
    const existingTags: string[] = Array.isArray(recordData.tags)
      ? recordData.tags
      : [];
    const mergedTags = Array.from(new Set([...existingTags, ...rawTags]));

    const result = await this.crmUpdate.updateField({
      tenantId,
      recordType: recordType as any,
      recordId,
      field: 'tags',
      value: mergedTags,
      sourceWorkflowId: job.sourceWorkflowId,
      automationDepth: job.automationDepth,
      automationBreadcrumbs: job.automationBreadcrumbs,
    });

    if (!result.success) {
      return {
        success: false,
        error: {
          code: 'ADD_TAG_FAILED',
          message:
            result.error || `Failed to add tags to ${recordType}(${recordId})`,
        },
      };
    }

    this.logger.log(
      `[AddTag] ✅ Tags added to ${recordType}(${recordId}): [${rawTags.join(', ')}]`,
    );

    return {
      success: true,
      output: { addedTags: rawTags, mergedTags },
    };
  }
}
