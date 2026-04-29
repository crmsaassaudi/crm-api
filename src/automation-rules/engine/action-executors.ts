import { Injectable, Logger } from '@nestjs/common';
import { AutomationActionJobData } from '../queue/automation-queue.constants';

/**
 * Base interface for all action executors.
 * Each executor handles one action type (email, sms, update_field, route).
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

  // eslint-disable-next-line @typescript-eslint/require-await
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

    const subject = this.interpolate(actionConfig.subject || '', recordData);
    const body = this.interpolate(actionConfig.template || '', recordData);

    if (!to) {
      return {
        success: false,
        error: {
          code: 'NO_EMAIL',
          message: `Record ${recordId} (${recordType}) has no email address`,
        },
      };
    }

    this.logger.log(
      `[SendEmail] tenant=${tenantId} to=${to} subject="${subject}"`,
    );

    // TODO: Integrate with actual email provider (SendGrid, SES, etc.)
    // For now, log the email that would be sent
    return {
      success: true,
      output: { to, subject, bodyLength: body.length },
    };
  }

  private interpolate(template: string, data: Record<string, any>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
      const keys = path.split('.');
      let value: any = data;
      for (const key of keys) {
        value = value?.[key];
      }
      return value !== undefined && value !== null ? String(value) : '';
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Send SMS Executor
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SendSmsExecutor implements ActionExecutor {
  readonly actionType = 'send_sms';
  private readonly logger = new Logger(SendSmsExecutor.name);

  // eslint-disable-next-line @typescript-eslint/require-await
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

    const message = this.interpolate(actionConfig.message || '', recordData);

    if (!phone) {
      return {
        success: false,
        error: {
          code: 'NO_PHONE',
          message: `Record ${recordId} (${recordType}) has no phone number`,
        },
      };
    }

    if (message.length > 160) {
      this.logger.warn(
        `[SendSMS] Message exceeds 160 chars (${message.length}) for record ${recordId}`,
      );
    }

    this.logger.log(
      `[SendSMS] tenant=${tenantId} to=${phone} chars=${message.length}`,
    );

    // TODO: Integrate with SMS provider (Twilio, Vonage, etc.)
    return {
      success: true,
      output: { phone, messageLength: message.length },
    };
  }

  private interpolate(template: string, data: Record<string, any>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
      const keys = path.split('.');
      let value: any = data;
      for (const key of keys) {
        value = value?.[key];
      }
      return value !== undefined && value !== null ? String(value) : '';
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Update Field Executor
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class UpdateFieldExecutor implements ActionExecutor {
  readonly actionType = 'update_field';
  private readonly logger = new Logger(UpdateFieldExecutor.name);

  // eslint-disable-next-line @typescript-eslint/require-await
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

    // TODO: Call the appropriate service (ContactsService, TicketsService)
    // to update the record field. Must set _automationSourceWorkflowId
    // in the event payload to prevent self-loop triggers.
    return {
      success: true,
      output: {
        recordType,
        recordId,
        field,
        previousValue: job.recordData[field],
        newValue: value,
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

  // eslint-disable-next-line @typescript-eslint/require-await
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

    // TODO: Call AssignmentEngineService to route the record to the
    // specified team/user. For tickets: update groupId + ownerId.
    // For contacts: update ownerId.
    return {
      success: true,
      output: {
        recordType,
        recordId,
        assignedTeam: teamId,
        assignedUser: userId || 'round-robin',
      },
    };
  }
}
