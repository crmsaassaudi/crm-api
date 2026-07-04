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
import { NotesService } from '../../notes/notes.service';
import { ContactsService } from '../../contacts/contacts.service';
import { DealsService } from '../../deals/deals.service';
import { AccountsService } from '../../accounts/accounts.service';

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
        allowRestricted: true,
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
        allowRestricted: true,
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

      // Consume the response body to release the TCP connection (PERF-04).
      await response.body?.cancel().catch(() => {});
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

    // Re-fetch fresh record to avoid stale-data race condition.
    // The job payload's recordData may be stale (serialized at dispatch time).
    // Two concurrent add_tag jobs on the same record would overwrite each other
    // without this fresh read.
    const freshRecord = await this.crmUpdate.fetchRecord(
      recordType as any,
      recordId,
    );
    const existingTags: string[] = Array.isArray(freshRecord?.tags)
      ? freshRecord.tags
      : Array.isArray(recordData.tags)
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

// ---------------------------------------------------------------------------
// Remove Tag Executor
// ---------------------------------------------------------------------------

@Injectable()
export class RemoveTagExecutor implements ActionExecutor {
  readonly actionType = 'remove_tag';
  private readonly logger = new Logger(RemoveTagExecutor.name);

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
      `[RemoveTag] tenant=${tenantId} ${recordType}(${recordId}) -= [${rawTags.join(', ')}]`,
    );

    // Re-fetch fresh record to avoid stale-data race condition (same as AddTag).
    const freshRecord = await this.crmUpdate.fetchRecord(
      recordType as any,
      recordId,
    );
    const existingTags: string[] = Array.isArray(freshRecord?.tags)
      ? freshRecord.tags
      : Array.isArray(recordData.tags)
        ? recordData.tags
        : [];
    const removeSet = new Set(rawTags);
    const filteredTags = existingTags.filter((t) => !removeSet.has(t));

    // Skip DB write if no change (idempotent optimization)
    if (filteredTags.length === existingTags.length) {
      this.logger.log(
        `[RemoveTag] No-op: none of [${rawTags.join(', ')}] found on ${recordType}(${recordId})`,
      );
      return {
        success: true,
        output: { removedTags: [], remainingTags: existingTags },
      };
    }

    const result = await this.crmUpdate.updateField({
      tenantId,
      recordType: recordType as any,
      recordId,
      field: 'tags',
      value: filteredTags,
      sourceWorkflowId: job.sourceWorkflowId,
      automationDepth: job.automationDepth,
      automationBreadcrumbs: job.automationBreadcrumbs,
    });

    if (!result.success) {
      return {
        success: false,
        error: {
          code: 'REMOVE_TAG_FAILED',
          message:
            result.error ||
            `Failed to remove tags from ${recordType}(${recordId})`,
        },
      };
    }

    const actuallyRemoved = existingTags.filter((t) => removeSet.has(t));
    this.logger.log(
      `[RemoveTag] ✅ Removed [${actuallyRemoved.join(', ')}] from ${recordType}(${recordId})`,
    );

    return {
      success: true,
      output: { removedTags: actuallyRemoved, remainingTags: filteredTags },
    };
  }
}

// ---------------------------------------------------------------------------
// Add Note Executor
// ---------------------------------------------------------------------------

@Injectable()
export class AddNoteExecutor implements ActionExecutor {
  readonly actionType = 'add_note';
  private readonly logger = new Logger(AddNoteExecutor.name);

  constructor(
    private readonly notesService: NotesService,
    private readonly templateEngine: TemplateInterpolationService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const content = this.templateEngine.interpolate(
      actionConfig.content || '',
      recordData,
      { fallbackMap: { firstName: 'Record', Name: 'Record' } },
    );

    if (!content.trim()) {
      return {
        success: false,
        error: {
          code: 'EMPTY_NOTE',
          message: 'Note content is empty after interpolation',
        },
      };
    }

    // Resolve contactId: direct if Contact, else look in recordData hierarchy
    const contactId =
      recordType === 'Contact'
        ? recordId
        : recordData.contactId || recordData.relatedContact?.id || undefined;

    this.logger.log(
      `[AddNote] tenant=${tenantId} contactId=${contactId || 'N/A'} noteType=${actionConfig.noteType || 'system'} contentLength=${content.length}`,
    );

    // If we have a contactId, create a real note
    if (contactId) {
      try {
        const note = await this.notesService.createForContact(contactId, {
          content,
          title: `[Automation] ${content.length > 60 ? content.slice(0, 60) + '...' : content}`,
        } as any);

        this.logger.log(
          `[AddNote] ✅ Note ${note.id} created for contact=${contactId} via ${recordType}(${recordId})`,
        );

        return {
          success: true,
          output: {
            noteId: note.id,
            contactId,
            noteType: actionConfig.noteType || 'system',
          },
        };
      } catch (err: any) {
        this.logger.error(`[AddNote] Failed: ${err.message}`, err.stack);
        return {
          success: false,
          error: { code: 'ADD_NOTE_FAILED', message: err.message },
        };
      }
    }

    // Fallback: emit as activity log event if no contact context
    this.logger.log(
      `[AddNote] No contactId resolvable for ${recordType}(${recordId}), emitting as activity event`,
    );
    this.eventEmitter?.emit('automation.note-fallback', {
      tenantId,
      recordType,
      recordId,
      content,
      noteType: actionConfig.noteType || 'system',
    });

    return {
      success: true,
      output: {
        fallback: true,
        recordType,
        recordId,
        noteType: actionConfig.noteType,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Create Record Executor
// ---------------------------------------------------------------------------

@Injectable()
export class CreateRecordExecutor implements ActionExecutor {
  readonly actionType = 'create_record';
  private readonly logger = new Logger(CreateRecordExecutor.name);

  /** Record type → service mapping, resolved lazily to avoid circular deps */
  private static readonly SUPPORTED_TYPES = new Set([
    'Contact',
    'Lead',
    'Deal',
    'Account',
    'Ticket',
    'Task',
  ]);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    @Optional() private readonly contactsService?: ContactsService,
    @Optional() private readonly dealsService?: DealsService,
    @Optional() private readonly ticketsService?: TicketsService,
    @Optional() private readonly tasksService?: TasksService,
    @Optional() private readonly accountsService?: AccountsService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;
    const targetType = actionConfig.recordType || 'Contact';

    if (!CreateRecordExecutor.SUPPORTED_TYPES.has(targetType)) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'UNSUPPORTED_RECORD_TYPE',
          message: `Record type "${targetType}" is not supported. Valid: ${[...CreateRecordExecutor.SUPPORTED_TYPES].join(', ')}`,
        },
      };
    }

    // Parse field mappings: JSON string → object, then interpolate each value
    let fieldData: Record<string, any>;
    try {
      const raw =
        typeof actionConfig.fieldMappings === 'string'
          ? JSON.parse(actionConfig.fieldMappings)
          : actionConfig.fieldMappings || {};

      fieldData = {};
      for (const [key, val] of Object.entries(raw)) {
        fieldData[key] =
          typeof val === 'string'
            ? this.templateEngine.interpolate(val, recordData)
            : val;
      }
    } catch (err: any) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'INVALID_FIELD_MAPPINGS',
          message: `Failed to parse fieldMappings: ${err.message}`,
        },
      };
    }

    this.logger.log(
      `[CreateRecord] tenant=${tenantId} type=${targetType} fields=${Object.keys(fieldData).length} triggeredBy=${recordType}(${recordId})`,
    );

    try {
      const created = await this.createByType(targetType, fieldData);

      this.logger.log(
        `[CreateRecord] ✅ Created ${targetType} ${created.id} with ${Object.keys(fieldData).length} fields`,
      );

      return {
        success: true,
        output: { recordType: targetType, recordId: created.id },
      };
    } catch (err: any) {
      this.logger.error(`[CreateRecord] Failed: ${err.message}`, err.stack);

      // Mongoose ValidationError → non-retryable
      const retryable =
        err.name !== 'ValidationError' && err.name !== 'CastError';
      return {
        success: false,
        retryable,
        error: { code: 'CREATE_RECORD_FAILED', message: err.message },
      };
    }
  }

  private async createByType(
    type: string,
    data: Record<string, any>,
  ): Promise<{ id: string }> {
    switch (type) {
      case 'Contact':
      case 'Lead':
        if (!this.contactsService)
          throw new Error('ContactsService not available');
        return this.contactsService.create(data as any);
      case 'Deal':
        if (!this.dealsService) throw new Error('DealsService not available');
        return this.dealsService.create(data as any);
      case 'Ticket':
        if (!this.ticketsService)
          throw new Error('TicketsService not available');
        return this.ticketsService.create(data as any);
      case 'Task':
        if (!this.tasksService) throw new Error('TasksService not available');
        return this.tasksService.create(data as any);
      case 'Account':
        if (!this.accountsService)
          throw new Error('AccountsService not available');
        return this.accountsService.create(data as any);
      default:
        throw new Error(`Unsupported type: ${type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP Request Executor
// ---------------------------------------------------------------------------

/** Hard timeout for HTTP requests (milliseconds). */
const HTTP_REQUEST_HARD_TIMEOUT_MS = 5000;
/** Max response body size to prevent memory bombs (bytes). */
const HTTP_RESPONSE_MAX_BYTES = 65_536; // 64 KB

@Injectable()
export class HttpRequestExecutor implements ActionExecutor {
  readonly actionType = 'http_request';
  private readonly logger = new Logger(HttpRequestExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    private readonly ssrfGuard: SsrfGuardService,
    private readonly crmUpdate: CrmRecordUpdateService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { actionConfig, recordData, tenantId, recordId, recordType } = job;
    const url = actionConfig.url;
    const method = (actionConfig.method || 'GET').toUpperCase();

    if (!url) {
      return {
        success: false,
        error: { code: 'NO_URL', message: 'url is required for http_request' },
      };
    }

    // SSRF Guard
    const ssrfCheck = await this.ssrfGuard.validate(url);
    if (!ssrfCheck.safe) {
      this.logger.warn(
        `[HttpRequest] SSRF BLOCKED: ${url} - ${ssrfCheck.reason}`,
      );
      return {
        success: false,
        retryable: false,
        error: { code: 'SSRF_BLOCKED', message: ssrfCheck.reason! },
      };
    }

    // DNS Pinning
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

    // Build headers from config
    const userHeaders: Record<string, string> = {};
    if (Array.isArray(actionConfig.headers)) {
      for (const h of actionConfig.headers) {
        if (h.key && h.value) {
          userHeaders[h.key] = this.templateEngine.interpolate(
            h.value,
            recordData,
          );
        }
      }
    }

    // Interpolate body
    let bodyStr: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      bodyStr = actionConfig.bodyTemplate
        ? this.templateEngine.interpolate(actionConfig.bodyTemplate, recordData)
        : JSON.stringify(recordData);
    }

    this.logger.log(
      `[HttpRequest] tenant=${tenantId} ${method} ${url} bodyLength=${bodyStr?.length || 0}`,
    );

    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        HTTP_REQUEST_HARD_TIMEOUT_MS,
      );

      const fetchOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...userHeaders,
          ...pinnedHeaders,
        },
        signal: controller.signal,
      };

      if (bodyStr) {
        fetchOptions.body = bodyStr;
      }

      const response = await fetch(fetchUrl, fetchOptions);

      // Read response with size limit
      const responseBody = await this.readResponseCapped(response);
      clearTimeout(timer);

      if (!response.ok) {
        return {
          success: false,
          error: {
            code: 'HTTP_ERROR',
            message: `HTTP ${response.status} ${response.statusText}: ${responseBody.substring(0, 200)}`,
          },
        };
      }

      // Response mapping: extract values and write back to record
      let mappedOutput: Record<string, any> = {};
      if (actionConfig.responseMapping && responseBody) {
        mappedOutput = await this.applyResponseMapping(
          actionConfig.responseMapping,
          responseBody,
          { tenantId, recordType, recordId, job },
        );
      }

      return {
        success: true,
        output: {
          status: response.status,
          url,
          method,
          responseMapped: Object.keys(mappedOutput).length > 0,
          ...mappedOutput,
        },
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        this.logger.warn(
          `[HttpRequest] TIMEOUT after ${HTTP_REQUEST_HARD_TIMEOUT_MS}ms: ${url}`,
        );
        return {
          success: false,
          error: {
            code: 'HTTP_TIMEOUT',
            message: `Request to ${url} timed out`,
          },
        };
      }

      this.logger.error(`[HttpRequest] Failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: { code: 'HTTP_ERROR', message: error.message },
      };
    }
  }

  /** Read response body up to HTTP_RESPONSE_MAX_BYTES to prevent memory bombs. */
  private async readResponseCapped(response: Response): Promise<string> {
    try {
      const reader = response.body?.getReader();
      if (!reader) return '';

      const chunks: Uint8Array[] = [];
      let totalSize = 0;

      while (totalSize < HTTP_RESPONSE_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalSize += value.length;
      }

      reader.cancel().catch(() => {});
      const merged = new Uint8Array(
        Math.min(totalSize, HTTP_RESPONSE_MAX_BYTES),
      );
      let offset = 0;
      for (const chunk of chunks) {
        const copyLen = Math.min(
          chunk.length,
          HTTP_RESPONSE_MAX_BYTES - offset,
        );
        merged.set(chunk.subarray(0, copyLen), offset);
        offset += copyLen;
        if (offset >= HTTP_RESPONSE_MAX_BYTES) break;
      }
      return new TextDecoder().decode(merged);
    } catch {
      return '';
    }
  }

  /**
   * Apply response mapping: parse JSON response, extract value at dot-path,
   * write back to record via CrmRecordUpdateService.
   *
   * Format: "response.path → recordField" (one mapping per line)
   */
  private async applyResponseMapping(
    mappingStr: string,
    responseBody: string,
    ctx: {
      tenantId: string;
      recordType: string;
      recordId: string;
      job: AutomationActionJobData;
    },
  ): Promise<Record<string, any>> {
    const result: Record<string, any> = {};
    try {
      const responseJson = JSON.parse(responseBody);
      const lines = mappingStr
        .split('\n')
        .filter((l) => l.includes('→') || l.includes('->'));

      for (const line of lines) {
        const [srcPath, targetField] = line.split(/→|->/).map((s) => s.trim());
        if (!srcPath || !targetField) continue;

        // Extract value at dot-notation path: O(depth) where depth ≤ 10
        const value = this.getNestedValue(responseJson, srcPath);
        if (value !== undefined) {
          await this.crmUpdate.updateField({
            tenantId: ctx.tenantId,
            recordType: ctx.recordType as any,
            recordId: ctx.recordId,
            field: targetField,
            value,
            sourceWorkflowId: ctx.job.sourceWorkflowId,
            automationDepth: ctx.job.automationDepth,
            automationBreadcrumbs: ctx.job.automationBreadcrumbs,
          });
          result[targetField] = value;
        }
      }
    } catch (err: any) {
      this.logger.warn(`[HttpRequest] Response mapping error: ${err.message}`);
    }
    return result;
  }

  /** Safely traverse nested object by dot-path. Capped at 10 levels to prevent abuse. */
  private getNestedValue(obj: any, path: string): any {
    const parts = path.split('.');
    if (parts.length > 10) return undefined;
    let current = obj;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }
}

// ---------------------------------------------------------------------------
// Send WhatsApp Executor (dry-run stub — Meta WABA integration pending)
// ---------------------------------------------------------------------------

@Injectable()
export class SendWhatsAppExecutor implements ActionExecutor {
  readonly actionType = 'send_whatsapp';
  private readonly logger = new Logger(SendWhatsAppExecutor.name);

  constructor(private readonly templateEngine: TemplateInterpolationService) {}

  execute(job: AutomationActionJobData): ActionExecutionResult {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const recipientField = actionConfig.recipientField || 'phones';
    const phone =
      recordData[recipientField]?.[0] ||
      recordData[recipientField] ||
      recordData.phones?.[0];

    if (!phone) {
      return {
        success: false,
        error: {
          code: 'NO_PHONE',
          message: `No phone found in field "${recipientField}"`,
        },
      };
    }

    const templateName = this.templateEngine.interpolate(
      actionConfig.templateName || '',
      recordData,
    );

    if (!templateName) {
      return {
        success: false,
        error: {
          code: 'NO_TEMPLATE',
          message: 'WhatsApp template name is required',
        },
      };
    }

    this.logger.log(
      `[SendWhatsApp] DRY-RUN tenant=${tenantId} to=${phone} template="${templateName}" lang=${actionConfig.language || 'vi'}`,
    );

    // TODO: Integrate with Meta Cloud API POST /v17.0/{phone_id}/messages
    // For now, log and return success (dry-run mode)
    return {
      success: true,
      output: {
        dryRun: true,
        to: phone,
        templateName,
        language: actionConfig.language || 'vi',
        recordType,
        recordId,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Send ZNS Executor (dry-run stub — Zalo OA integration pending)
// ---------------------------------------------------------------------------

@Injectable()
export class SendZnsExecutor implements ActionExecutor {
  readonly actionType = 'send_zns';
  private readonly logger = new Logger(SendZnsExecutor.name);

  constructor(private readonly templateEngine: TemplateInterpolationService) {}

  execute(job: AutomationActionJobData): ActionExecutionResult {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const recipientField = actionConfig.recipientField || 'phones';
    const phone =
      recordData[recipientField]?.[0] ||
      recordData[recipientField] ||
      recordData.phones?.[0];

    if (!phone) {
      return {
        success: false,
        error: {
          code: 'NO_PHONE',
          message: `No phone found in field "${recipientField}"`,
        },
      };
    }

    const templateId = actionConfig.templateId;
    if (!templateId) {
      return {
        success: false,
        error: {
          code: 'NO_TEMPLATE_ID',
          message: 'ZNS template ID is required',
        },
      };
    }

    // Parse and interpolate template params
    let params: Record<string, any> = {};
    try {
      const raw =
        typeof actionConfig.params === 'string'
          ? JSON.parse(actionConfig.params)
          : actionConfig.params || {};

      for (const [key, val] of Object.entries(raw)) {
        params[key] =
          typeof val === 'string'
            ? this.templateEngine.interpolate(val, recordData)
            : val;
      }
    } catch {
      params = {};
    }

    this.logger.log(
      `[SendZNS] DRY-RUN tenant=${tenantId} to=${phone} templateId=${templateId} params=${JSON.stringify(params)}`,
    );

    // TODO: Integrate with Zalo OA API POST /oa/message/cs
    return {
      success: true,
      output: {
        dryRun: true,
        to: phone,
        templateId,
        params,
        recordType,
        recordId,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Send Livechat Executor (event-driven)
// ---------------------------------------------------------------------------

@Injectable()
export class SendLivechatExecutor implements ActionExecutor {
  readonly actionType = 'send_livechat';
  private readonly logger = new Logger(SendLivechatExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    // Resolve conversation ID
    const conversationId =
      recordType === 'Conversation'
        ? recordId
        : recordData.conversationId ||
          recordData.omniConversationId ||
          undefined;

    if (!conversationId) {
      return {
        success: false,
        error: {
          code: 'NO_CONVERSATION',
          message: `Cannot resolve conversation ID from ${recordType}(${recordId})`,
        },
      };
    }

    const message = this.templateEngine.interpolate(
      actionConfig.message || '',
      recordData,
      { fallbackMap: { firstName: 'Customer', Name: 'Customer' } },
    );

    if (!message.trim()) {
      return {
        success: false,
        error: {
          code: 'EMPTY_MESSAGE',
          message: 'Livechat message is empty after interpolation',
        },
      };
    }

    this.logger.log(
      `[SendLivechat] tenant=${tenantId} conversation=${conversationId} messageLength=${message.length}`,
    );

    // Guard: EventEmitter is required for delivery
    if (!this.eventEmitter) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'NO_EVENT_BUS',
          message:
            'EventEmitter not injected — cannot deliver livechat message',
        },
      };
    }

    // Async emit: waits for all listeners to complete, surfaces errors
    try {
      await this.eventEmitter.emitAsync('livechat.system-message', {
        tenantId,
        conversationId,
        message,
        source: 'automation',
        workflowId: job.workflowId,
      });
    } catch (err: any) {
      this.logger.error(
        `[SendLivechat] Delivery failed: ${err.message}`,
        err.stack,
      );
      return {
        success: false,
        error: { code: 'LIVECHAT_DELIVERY_FAILED', message: err.message },
      };
    }

    return {
      success: true,
      output: { conversationId, messageLength: message.length },
    };
  }
}

// ---------------------------------------------------------------------------
// Internal Notification Executor (event-driven)
// ---------------------------------------------------------------------------

@Injectable()
export class InternalNotificationExecutor implements ActionExecutor {
  readonly actionType = 'internal_notification';
  private readonly logger = new Logger(InternalNotificationExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const title = this.templateEngine.interpolate(
      actionConfig.title || 'Workflow Notification',
      recordData,
      { fallbackMap: { firstName: 'Record', Name: 'Record' } },
    );

    const message = this.templateEngine.interpolate(
      actionConfig.message || '',
      recordData,
      { fallbackMap: { firstName: 'Record', Name: 'Record' } },
    );

    const recipientType = actionConfig.recipientType || 'owner';

    // Resolve recipient IDs based on type
    let recipientIds: string[] = [];
    switch (recipientType) {
      case 'owner':
        if (recordData.ownerId) recipientIds = [recordData.ownerId];
        break;
      case 'team':
        // Team members are resolved by the notification consumer
        break;
      case 'specific':
        if (actionConfig.specificUserId)
          recipientIds = [actionConfig.specificUserId];
        break;
      case 'all_admins':
        // Resolved by the notification consumer (needs tenant user query)
        break;
    }

    this.logger.log(
      `[InternalNotification] tenant=${tenantId} type=${recipientType} recipients=${recipientIds.length || recipientType} title="${title}"`,
    );

    // Guard: EventEmitter is required for delivery
    if (!this.eventEmitter) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'NO_EVENT_BUS',
          message: 'EventEmitter not injected — cannot send notification',
        },
      };
    }

    // Async emit: waits for all listeners to complete, surfaces errors
    try {
      await this.eventEmitter.emitAsync('internal.notification', {
        tenantId,
        recipientType,
        recipientIds,
        title,
        message,
        source: 'automation',
        context: {
          workflowId: job.workflowId,
          recordType,
          recordId,
        },
      });
    } catch (err: any) {
      this.logger.error(
        `[InternalNotification] Delivery failed: ${err.message}`,
        err.stack,
      );
      return {
        success: false,
        error: { code: 'NOTIFICATION_DELIVERY_FAILED', message: err.message },
      };
    }

    return {
      success: true,
      output: {
        recipientType,
        recipientCount: recipientIds.length || recipientType,
        title,
      },
    };
  }
}
