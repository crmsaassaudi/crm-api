import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import nodemailer from 'nodemailer';
import { ActionExecutionResult, ActionExecutor } from './executor.interface';
import { AutomationActionJobData } from '../../queue/automation-queue.constants';
import { TemplateVariableRegistryService } from '../../../templates/services/template-variable-registry.service';
import {
  ResolvedTransport,
  TransportPoolService,
} from '../../../channels/transport-pool.service';
import { ChannelConfigRepository } from '../../../channels/infrastructure/persistence/document/repositories/channel-config.repository';
import {
  classifyProviderError,
  ErrorSeverity,
} from '../../../channels/domain/error-classifier';
import { OutboundService } from '../../../omni-outbound/outbound.service';

abstract class ChannelMessageExecutor implements ActionExecutor {
  abstract readonly actionType: string;
  protected abstract readonly logger: Logger;
  /** Provider types this action can send through. */
  protected abstract readonly supportedProviderTypes: readonly string[];

  constructor(
    protected readonly templateEngine: TemplateVariableRegistryService,
    private readonly transportPool: TransportPoolService,
    private readonly channelConfigRepo: ChannelConfigRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const configId = job.actionConfig.configId;
    if (!configId) {
      return this.permanent(
        'NO_CHANNEL_CONFIG',
        `${this.actionType} requires a channel config. Pick one on the action node.`,
      );
    }

    const recipient = this.resolveRecipient(job);
    if (!recipient) {
      return {
        success: false,
        error: {
          code: 'NO_RECIPIENT',
          message: `Record ${job.recordId} (${job.recordType}) has no ${this.recipientLabel}`,
        },
      };
    }

    const transport = await this.transportPool.resolveWithTenantGuard(
      configId,
      job.tenantId,
    );

    if (!transport) {
      return this.permanent(
        'CHANNEL_CONFIG_NOT_FOUND',
        `Channel config ${configId} not found or deleted. Please update the workflow.`,
      );
    }
    if (!this.supportedProviderTypes.includes(transport.providerType)) {
      return this.permanent(
        'UNSUPPORTED_PROVIDER',
        `${this.actionType} cannot send through a "${transport.providerType}" config. ` +
          `Supported: ${this.supportedProviderTypes.join(', ')}.`,
      );
    }
    if (transport.status === 'error') {
      return this.permanent(
        'CONFIG_SUSPENDED',
        `Channel config "${transport.name}" is in error state (credentials may be invalid). ` +
          'Fix it in Settings > Channel Config, then retry from the DLQ.',
      );
    }

    try {
      const result = await this.send(job, transport, recipient);
      if (!result.success && result.error) {
        return this.classify(configId, transport, result);
      }
      return result;
    } catch (err: any) {
      this.logger.error(
        `[${this.actionType}] send failed: ${err.message}`,
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

  protected abstract resolveRecipient(
    job: AutomationActionJobData,
  ): string | undefined;

  protected abstract readonly recipientLabel: string;

  protected abstract send(
    job: AutomationActionJobData,
    transport: ResolvedTransport,
    recipient: string,
  ): Promise<ActionExecutionResult>;

  private async classify(
    configId: string,
    transport: ResolvedTransport,
    result: ActionExecutionResult,
  ): Promise<ActionExecutionResult> {
    const classified = classifyProviderError({
      message: result.error!.message,
      code: result.error!.code,
    });

    if (classified.severity !== ErrorSeverity.PERMANENT) {
      this.logger.log(
        `[${this.actionType}] TRANSIENT error: ${classified.code} — will retry`,
      );
      return result;
    }

    this.logger.warn(
      `[${this.actionType}] PERMANENT error for config "${transport.name}": ${classified.code}`,
    );

    if (classified.shouldUpdateConfigStatus) {
      await this.channelConfigRepo.updateHealthStatus(configId, {
        status: 'error',
        lastHealthError: classified.message,
        consecutiveFailures: (transport.consecutiveFailures ?? 0) + 1,
      });
      this.eventEmitter.emit('channel-config.runtime-failure', {
        configId,
        tenantId: transport.tenantId,
        httpStatus: classified.httpStatus,
      });
    }

    return { ...result, retryable: false };
  }

  protected permanent(code: string, message: string): ActionExecutionResult {
    return { success: false, retryable: false, error: { code, message } };
  }
}

@Injectable()
export class SendEmailExecutor extends ChannelMessageExecutor {
  readonly actionType = 'send_email';
  protected readonly logger = new Logger(SendEmailExecutor.name);
  protected readonly supportedProviderTypes = ['smtp'] as const;
  protected readonly recipientLabel = 'email address';

  protected resolveRecipient(job: AutomationActionJobData): string | undefined {
    const { recordData, recordType } = job;
    const direct = recordData.emails?.[0] || recordData.email;
    if (direct) return direct;

    if (recordType === 'Task') {
      return (
        recordData.contactEmail ||
        recordData.accountEmail ||
        recordData.relatedContact?.email ||
        recordData.relatedAccount?.emails?.[0]
      );
    }
    return undefined;
  }

  protected async send(
    job: AutomationActionJobData,
    transport: ResolvedTransport,
    to: string,
  ): Promise<ActionExecutionResult> {
    const { actionConfig, recordData, tenantId } = job;

    const subject = this.templateEngine.render(
      actionConfig.subject ?? '',
      recordData,
      { mode: 'broad' },
    );
    const body = this.templateEngine.render(
      actionConfig.template ?? '',
      recordData,
      { mode: 'broad' },
    );

    const { user, password } = transport.credentials;
    const { host, port, fromEmail, fromName } = transport.publicSettings;
    if (!host || !user || !fromEmail) {
      return this.permanent(
        'CHANNEL_CONFIG_INCOMPLETE',
        `Channel config "${transport.name}" is missing host, user or fromEmail.`,
      );
    }

    const numPort = Number(port) || 587;
    const transporter = nodemailer.createTransport({
      host,
      port: numPort,
      secure: numPort === 465,
      auth: { user, pass: password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });

    this.logger.log(
      `[SendEmail] tenant=${tenantId} config="${transport.name}" to=${to} subject="${subject}"`,
    );

    try {
      const result = await transporter.sendMail({
        from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
        to,
        subject,
        html: body,
      });
      return {
        success: true,
        output: { messageId: result.messageId, to, subject },
      };
    } finally {
      transporter.close();
    }
  }
}

/** Twilio caps a single segment; longer bodies are split and billed per segment. */
const SMS_SEGMENT_CHARS = 160;

@Injectable()
export class SendSmsExecutor extends ChannelMessageExecutor {
  readonly actionType = 'send_sms';
  protected readonly logger = new Logger(SendSmsExecutor.name);
  protected readonly supportedProviderTypes = ['twilio'] as const;
  protected readonly recipientLabel = 'phone number';

  protected resolveRecipient(job: AutomationActionJobData): string | undefined {
    const { recordData, recordType } = job;
    const direct = recordData.phones?.[0] || recordData.phone;
    if (direct) return direct;

    if (recordType === 'Task') {
      return (
        recordData.contactPhone ||
        recordData.accountPhone ||
        recordData.relatedContact?.phone ||
        recordData.relatedAccount?.phones?.[0]
      );
    }
    return undefined;
  }

  protected async send(
    job: AutomationActionJobData,
    transport: ResolvedTransport,
    to: string,
  ): Promise<ActionExecutionResult> {
    const message = this.templateEngine.render(
      job.actionConfig.message ?? '',
      job.recordData,
      { mode: 'broad' },
    );
    if (!message.trim()) {
      return this.permanent(
        'EMPTY_MESSAGE',
        'SMS body is empty after interpolation.',
      );
    }

    const { accountSid, authToken } = transport.credentials;
    const fromNumber = transport.publicSettings?.fromNumber;
    if (!accountSid || !authToken || !fromNumber) {
      return this.permanent(
        'CHANNEL_CONFIG_INCOMPLETE',
        `Channel config "${transport.name}" is missing accountSid, authToken or fromNumber.`,
      );
    }

    const segments = Math.ceil(message.length / SMS_SEGMENT_CHARS) || 1;
    this.logger.log(
      `[SendSMS] tenant=${job.tenantId} config="${transport.name}" to=${to} ` +
        `chars=${message.length} segments=${segments}`,
    );

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: to,
          From: fromNumber,
          Body: message,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(unreadable)');
      return {
        success: false,
        error: {
          code: 'SMS_SEND_FAILED',
          message: `Twilio API ${response.status}: ${errorBody.substring(0, 200)}`,
        },
      };
    }

    const result: any = await response.json();
    return {
      success: true,
      output: {
        sid: result.sid,
        status: result.status,
        messageLength: message.length,
        segments,
      },
    };
  }
}

@Injectable()
export class SendLivechatExecutor implements ActionExecutor {
  readonly actionType = 'send_livechat';
  private readonly logger = new Logger(SendLivechatExecutor.name);

  constructor(
    private readonly templateEngine: TemplateVariableRegistryService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const conversationId =
      recordType === 'Conversation'
        ? recordId
        : recordData.conversationId || recordData.omniConversationId;

    if (!conversationId) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'NO_CONVERSATION',
          message: `Cannot resolve a conversation from ${recordType}(${recordId})`,
        },
      };
    }

    const message = this.templateEngine.render(
      actionConfig.message ?? '',
      recordData,
      { mode: 'broad' },
    );
    if (!message.trim()) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'EMPTY_MESSAGE',
          message: 'Livechat message is empty after interpolation',
        },
      };
    }

    this.logger.log(
      `[SendLivechat] tenant=${tenantId} conversation=${conversationId} chars=${message.length}`,
    );

    const outbound = this.moduleRef.get(OutboundService, { strict: false });
    const result = await outbound.sendBotMessage({
      tenantId,
      conversationId,
      content: message,
      idempotencyKey: `automation:${job.executionId}:${job.nodeId}`,
    });

    if (result?.ok === false) {
      return {
        success: false,
        error: {
          code: 'LIVECHAT_SEND_FAILED',
          message: result.error ?? 'Outbound send rejected the message',
        },
      };
    }

    return {
      success: true,
      output: {
        conversationId,
        messageId: result?.messageId,
        messageLength: message.length,
      },
    };
  }
}
