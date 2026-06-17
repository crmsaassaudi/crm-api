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
import { TransportPoolService } from '../transport-pool.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EmailContentSchemaClass } from '../infrastructure/persistence/document/entities/email-content.schema';
import { EmailMetadataSchemaClass } from '../infrastructure/persistence/document/entities/email-metadata.schema';
import { OutboundQueueService } from '../services/outbound-queue.service';
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

    // 1. Resolve SMTP transport by configId (same as SendEmailExecutor)
    const transportConfig = await this.transportPool.resolveWithTenantGuard(
      dto.configId,
      tenantId,
    );

    if (!transportConfig || transportConfig.providerType !== 'smtp') {
      throw new NotFoundException(
        'Invalid or missing SMTP configuration for this channel',
      );
    }

    const { user, password } = transportConfig.credentials;
    const { host, port, fromEmail, fromName } = transportConfig.publicSettings;
    const numPort = Number(port);

    // 2. Throttle check
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

    // 3. Create Nodemailer transporter
    const transporter = nodemailer.createTransport({
      host,
      port: numPort,
      secure: numPort === 465,
      auth: { user, pass: password },
      tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
    });

    // 4. Build and send email
    const from = `"${fromName || 'CRM'}" <${fromEmail || user}>`;
    const generatedMessageId = new Types.ObjectId();

    try {
      const result = await transporter.sendMail({
        from,
        to: dto.to,
        cc: dto.cc || [],
        bcc: dto.bcc || [],
        subject: dto.subject,
        html: dto.htmlBody,
        messageId: `<${generatedMessageId}@crm.local>`,
      });

      this.logger.log(
        `[EmailSend] ✅ Sent to=${dto.to.join(',')} subject="${dto.subject}" messageId=${result.messageId}`,
      );

      // 5. Persist to email_contents for tracking (searchable)
      await this.emailContentModel.create({
        tenantId,
        messageId: generatedMessageId,
        contactIds: dto.contactId ? [dto.contactId] : [],
        subject: dto.subject,
        htmlBody: dto.htmlBody || '',
        textBody: '',
        attachments: [],
        from: fromEmail || user,
        to: dto.to,
        cc: dto.cc || [],
        rfc822MessageId: result.messageId || null,
      });

      // 6. Persist metadata for thread tracking
      await this.emailMetadataModel.create({
        tenantId,
        mailboxId: dto.configId,
        messageId: generatedMessageId,
        emailMessageId: result.messageId || `<${generatedMessageId}@crm.local>`,
        from: fromEmail || user,
        to: dto.to,
        cc: dto.cc || [],
        bcc: dto.bcc || [],
        crmFolder: 'sent',
        deliveryStatus: 'sent',
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
}
