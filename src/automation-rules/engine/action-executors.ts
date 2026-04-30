import { Injectable, Logger, Inject } from '@nestjs/common';
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Send Email Executor
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SendEmailExecutor implements ActionExecutor {
  readonly actionType = 'send_email';
  private readonly logger = new Logger(SendEmailExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    @Inject(EMAIL_PROVIDER_TOKEN)
    private readonly emailProvider: EmailProviderService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordData, actionConfig, tenantId, recordType } = job;

    // ── Polymorphic Task Support ──────────────────────────────────────────
    // Tasks don't have email directly. Resolve from parent entity.
    let to = recordData.emails?.[0] || recordData.email;
    if (!to && recordType === 'Task') {
      // Fallback: look for parent contact/account email attached to the task record
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

    // ── Template Interpolation with null-safe fallback ─────────────────
    const subject = this.templateEngine.interpolate(
      actionConfig.subject || '',
      recordData,
      { fallbackMap: { Name: 'Quý khách', firstName: 'Quý khách' } },
    );
    const body = this.templateEngine.interpolate(
      actionConfig.template || '',
      recordData,
      { fallbackMap: { Name: 'Quý khách', firstName: 'Quý khách' } },
    );

    this.logger.log(
      `[SendEmail] tenant=${tenantId} to=${to} subject="${subject}"`,
    );

    // ── Send via provider (SendGrid or dry-run) ────────────────────────
    return this.emailProvider.send({ to, subject, body });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Send SMS Executor
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SendSmsExecutor implements ActionExecutor {
  readonly actionType = 'send_sms';
  private readonly logger = new Logger(SendSmsExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    @Inject(SMS_PROVIDER_TOKEN)
    private readonly smsProvider: SmsProviderService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordData, actionConfig, tenantId, recordType } = job;

    // ── Polymorphic Task Support ──────────────────────────────────────────
    // Tasks don't have phone directly. Resolve from parent entity.
    let phone = recordData.phones?.[0] || recordData.phone;
    if (!phone && recordType === 'Task') {
      // Fallback: look for parent contact/account phone attached to the task record
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

    // ── Template Interpolation ──────────────────────────────────────────
    const message = this.templateEngine.interpolate(
      actionConfig.message || '',
      recordData,
      { fallbackMap: { Name: 'Quý khách', firstName: 'Quý khách' } },
    );

    if (message.length > 160) {
      this.logger.warn(
        `[SendSMS] Message exceeds 160 chars (${message.length}) for record ${recordId}`,
      );
    }

    this.logger.log(
      `[SendSMS] tenant=${tenantId} to=${phone} chars=${message.length}`,
    );

    // ── Send via provider (Twilio or dry-run) ───────────────────────────
    return this.smsProvider.send({ to: phone, message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Update Field Executor
// ─────────────────────────────────────────────────────────────────────────────

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

    // ── Call CRM service to update the record ───────────────────────────
    const result = await this.crmUpdate.updateField({
      tenantId,
      recordType,
      recordId,
      field,
      value,
      sourceWorkflowId: job.sourceWorkflowId,
      automationDepth: job.automationDepth,
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

// ─────────────────────────────────────────────────────────────────────────────
// Route to Team Executor
// ─────────────────────────────────────────────────────────────────────────────

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
      `[RouteToTeam] tenant=${tenantId} ${recordType}(${recordId}) → team=${teamId || 'N/A'} user=${userId || 'round-robin'}`,
    );

    // ── Direct user assignment (skip assignment engine) ─────────────────
    if (userId) {
      const result = await this.crmUpdate.updateField({
        tenantId,
        recordType,
        recordId,
        field: 'ownerId',
        value: userId,
        sourceWorkflowId: job.sourceWorkflowId,
        automationDepth: job.automationDepth,
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

    // ── Team-based assignment via AssignmentEngine (round-robin) ─────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Executor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard timeout cap for webhook requests (milliseconds).
 * Exceeding this → AbortError → WEBHOOK_TIMEOUT → retry → DLQ.
 */
const WEBHOOK_HARD_TIMEOUT_MS = 5000;

@Injectable()
export class WebhookExecutor implements ActionExecutor {
  readonly actionType = 'webhook';
  private readonly logger = new Logger(WebhookExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    private readonly ssrfGuard: SsrfGuardService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { actionConfig, recordData, tenantId } = job;
    const url = actionConfig.webhookUrl;
    const method = (actionConfig.method || 'POST').toUpperCase();
    const headers: Record<string, string> = actionConfig.headers || {};
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

    // ── SSRF Guard ────────────────────────────────────────────────────────
    const ssrfCheck = await this.ssrfGuard.validate(url);
    if (!ssrfCheck.safe) {
      this.logger.warn(`[Webhook] SSRF BLOCKED: ${url} — ${ssrfCheck.reason}`);
      return {
        success: false,
        error: { code: 'SSRF_BLOCKED', message: ssrfCheck.reason! },
      };
    }

    // ── Interpolate body template ─────────────────────────────────────────
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

    // ── HTTP Request with hard timeout ────────────────────────────────────
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const fetchOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        signal: controller.signal,
      };

      // Only attach body for non-GET requests
      if (method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = bodyStr;
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timer);

      if (!response.ok) {
        const responseBody = await response.text().catch(() => '(unreadable)');
        return {
          success: false,
          error: {
            code: 'WEBHOOK_HTTP_ERROR',
            message: `HTTP ${response.status} ${response.statusText}: ${responseBody.substring(0, 200)}`,
          },
        };
      }

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
