import {
  Controller,
  Post,
  Body,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { TransportPoolService } from './transport-pool.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EmailContentSchemaClass } from './infrastructure/persistence/document/entities/email-content.schema';
import { EmailMetadataSchemaClass } from './infrastructure/persistence/document/entities/email-metadata.schema';
import { OutboundQueueService } from './services/outbound-queue.service';
import nodemailer from 'nodemailer';

class SendEmailDto {
  configId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  htmlBody: string;
  contactId?: string;
}

/**
 * EmailSendController — Standalone email send endpoint.
 *
 * This controller enables sending emails **without** an omni conversationId.
 * It resolves SMTP credentials directly from configId via TransportPool,
 * following the same pattern as SendEmailExecutor in automation rules.
 *
 * When the email syncs back via IMAP, the system will auto-create
 * an omni conversation through the existing pipeline:
 *   ImapPoller → EmailInboundListener → ConversationService
 */
@ApiTags('Email Send')
@ApiBearerAuth()
@Controller({ path: 'channels', version: '1' })
export class EmailSendController {
  private readonly logger = new Logger(EmailSendController.name);

  constructor(
    private readonly cls: ClsService,
    private readonly transportPool: TransportPoolService,
    private readonly outboundQueue: OutboundQueueService,
    @InjectModel(EmailContentSchemaClass.name)
    private readonly emailContentModel: Model<EmailContentSchemaClass>,
    @InjectModel(EmailMetadataSchemaClass.name)
    private readonly emailMetadataModel: Model<EmailMetadataSchemaClass>,
  ) {}

  @Post('email/send')
  @ApiOperation({ summary: 'Send standalone email (no conversation required)' })
  async sendEmail(@Body() dto: SendEmailDto) {
    const tenantId = this.cls.get('tenantId');

    if (!tenantId) {
      throw new BadRequestException('Missing tenant context');
    }
    if (!dto.configId || !dto.to?.length || !dto.subject) {
      throw new BadRequestException('configId, to, and subject are required');
    }

    // 1. Resolve SMTP transport by configId
    const transportConfig = await this.resolveSmtpTransport(
      dto.configId,
      tenantId,
    );

    const { user, password } = transportConfig.credentials;
    const { host, port, fromEmail, fromName } = transportConfig.publicSettings;
    const numPort = Number(port);

    // 2. Throttle check
    await this.checkSendThrottle(tenantId, dto, host);

    // 3. Send email
    const generatedMessageId = new Types.ObjectId();
    const from = `"${fromName || 'CRM'}" <${fromEmail || user}>`;

    try {
      const result = await this.dispatchEmail({
        host,
        numPort,
        user,
        password,
        from,
        dto,
        generatedMessageId,
      });

      this.logger.log(
        `[EmailSend] ✅ Sent to=${dto.to.join(',')} subject="${dto.subject}" messageId=${result.messageId}`,
      );

      // 4. Persist tracking records
      await this.persistEmailRecords({
        tenantId,
        dto,
        generatedMessageId,
        fromEmail: fromEmail || user,
        rfc822MessageId: result.messageId,
      });

      return {
        ok: true,
        messageId: result.messageId,
        generatedMessageId: generatedMessageId.toString(),
      };
    } catch (error: any) {
      this.logger.error(`[EmailSend] ❌ Failed: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to send email: ${error.message}`);
    }
  }

  /** Resolve and validate SMTP transport config for the given channel. */
  private async resolveSmtpTransport(configId: string, tenantId: string) {
    const transportConfig = await this.transportPool.resolveWithTenantGuard(
      configId,
      tenantId,
    );

    if (!transportConfig || transportConfig.providerType !== 'smtp') {
      throw new NotFoundException(
        'Invalid or missing SMTP configuration for this channel',
      );
    }

    return transportConfig;
  }

  /** Check outbound throttle limits before sending. */
  private async checkSendThrottle(
    tenantId: string,
    dto: SendEmailDto,
    host: string,
  ): Promise<void> {
    const recipients = [
      ...(dto.to || []),
      ...(dto.cc || []),
      ...(dto.bcc || []),
    ];
    const throttleResult = await this.outboundQueue.checkSendAllowed(
      tenantId,
      dto.configId,
      host,
      recipients.length,
    );
    if (!throttleResult.allowed) {
      throw new BadRequestException(
        throttleResult.reason || 'Send rate limited',
      );
    }
  }

  /** Create Nodemailer transport and dispatch the email. */
  private async dispatchEmail(params: {
    host: string;
    numPort: number;
    user: string;
    password: string;
    from: string;
    dto: SendEmailDto;
    generatedMessageId: Types.ObjectId;
  }) {
    const transporter = nodemailer.createTransport({
      host: params.host,
      port: params.numPort,
      secure: params.numPort === 465,
      auth: { user: params.user, pass: params.password },
      tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
    });

    return transporter.sendMail({
      from: params.from,
      to: params.dto.to,
      cc: params.dto.cc || [],
      bcc: params.dto.bcc || [],
      subject: params.dto.subject,
      html: params.dto.htmlBody,
      messageId: `<${params.generatedMessageId}@crm.local>`,
    });
  }

  /** Persist email content and metadata for tracking and thread correlation. */
  private async persistEmailRecords(params: {
    tenantId: string;
    dto: SendEmailDto;
    generatedMessageId: Types.ObjectId;
    fromEmail: string;
    rfc822MessageId: string | false;
  }): Promise<void> {
    await this.emailContentModel.create({
      tenantId: params.tenantId,
      messageId: params.generatedMessageId,
      contactIds: params.dto.contactId ? [params.dto.contactId] : [],
      subject: params.dto.subject,
      htmlBody: params.dto.htmlBody || '',
      textBody: '',
      attachments: [],
      from: params.fromEmail,
      to: params.dto.to,
      cc: params.dto.cc || [],
      rfc822MessageId: params.rfc822MessageId || null,
    });

    await this.emailMetadataModel.create({
      tenantId: params.tenantId,
      mailboxId: params.dto.configId,
      messageId: params.generatedMessageId,
      emailMessageId:
        params.rfc822MessageId || `<${params.generatedMessageId}@crm.local>`,
      from: params.fromEmail,
      to: params.dto.to,
      cc: params.dto.cc || [],
      bcc: params.dto.bcc || [],
      crmFolder: 'sent',
      deliveryStatus: 'sent',
    });
  }
}
