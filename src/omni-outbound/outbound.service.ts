import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MessageRepository } from '../omni-inbound/repositories/message.repository';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import {
  ChannelAdapter,
  CHANNEL_ADAPTERS,
} from '../omni-inbound/adapters/channel-adapter.interface';
import { ChannelType } from '../omni-inbound/domain/omni-payload';

import { ChannelRepository } from '../channels/infrastructure/persistence/document/repositories/channel.repository';
import { ReplyWindowExpiredException } from './exceptions/reply-window-expired.exception';
import replyWindowConfig from './config/reply-window.config';

import { TransportPoolService } from '../channels/transport-pool.service';
import { OutboundQueueService } from '../channels/services/outbound-queue.service';
import { EmailSignatureService } from '../channels/services/email-signature.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmailContentDocument } from '../channels/infrastructure/persistence/document/entities/email-content.schema';
import { EmailMetadataDocument } from '../channels/infrastructure/persistence/document/entities/email-metadata.schema';
import * as nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import * as cheerio from 'cheerio';
import axios from 'axios';

/**
 * OutboundService — handles messages sent from Agents to Customers.
 *
 * Responsibilities:
 * 1. Persist the agent's message to the database.
 * 2. Update the conversation's last message and activity timestamp.
 * 3. Send the message to the provider's API (FB, Zalo, WA).
 */
@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);

  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly channelRepo: ChannelRepository,
    private readonly eventEmitter: EventEmitter2,
    @Inject(CHANNEL_ADAPTERS)
    private readonly adapters: Map<ChannelType, ChannelAdapter>,
    @Inject(replyWindowConfig.KEY)
    private readonly replyWindowCfg: ConfigType<typeof replyWindowConfig>,
    private readonly transportPool: TransportPoolService,
    private readonly outboundQueue: OutboundQueueService,
    private readonly emailSignatureService: EmailSignatureService,
    @InjectModel('EmailContentSchemaClass')
    private readonly emailContentModel: Model<EmailContentDocument>,
    @InjectModel('EmailMetadataSchemaClass')
    private readonly emailMetadataModel: Model<EmailMetadataDocument>,
  ) {}

  /**
   * Send a reply from an agent to a customer.
   */
  async sendAgentMessage(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    content: string;
    messageType?: string;
    source?: 'http' | 'socket';
  }): Promise<any> {
    const {
      tenantId,
      conversationId,
      agentId,
      content,
      messageType = 'text',
      source = 'http',
    } = params;

    // 1. Fetch conversation to get channel details and external ID
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    let channel = await this.channelRepo.findByIdWithCredentials(
      tenantId,
      conversation.channelId.toString(),
    );

    // Fallback: If channel record was deleted/re-created, try finding by account
    if (!channel && (conversation as any).channelAccount) {
      this.logger.log(
        `Channel ${conversation.channelId} not found, searching by account ${(conversation as any).channelAccount}`,
      );
      channel = await this.channelRepo.findByAccountWithCredentials(
        tenantId,
        conversation.channelType,
        (conversation as any).channelAccount,
      );
    }

    if (!channel) {
      throw new Error(
        `Channel for conversation ${conversationId} not found or disconnected`,
      );
    }

    // 2. Enforce platform reply window
    this.enforceReplyWindow(conversation);

    this.logger.log(
      `Agent ${agentId} sending ${messageType} to conversation ${conversationId}`,
    );

    // 3. Persist to MessageRepository
    const message = await this.messageRepo.create({
      tenantId: tenantId,
      conversationId: conversationId,
      senderId: agentId,
      senderType: 'agent',
      messageType,
      content,
      status: 'sending',
    });

    // 3. Update conversation last message summary
    await this.conversationRepo.updateLastMessage(
      conversationId,
      content.substring(0, 200),
      new Date(),
      'agent',
    );

    // 4. Send to Provider API via Adapter
    try {
      let adapterResponse: any = null;
      const adapter = this.adapters.get(
        conversation.channelType.toLowerCase() as ChannelType,
      );
      if (adapter) {
        adapterResponse = await adapter.send(
          conversation.customer.externalId,
          content,
          messageType,
          { credentials: channel.credentials, account: channel.account },
        );
      }

      // Update status to sent and save external ID
      const externalId =
        (adapterResponse as any)?.message_id || (adapterResponse as any)?.id;
      await this.messageRepo.updateStatus(message.id, 'sent', externalId);

      this.eventEmitter.emit('omni.message.sent', {
        tenantId,
        conversationId,
        senderId: agentId,
        senderType: 'agent',
        messageType,
        content,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        timestamp: new Date().toISOString(),
        source,
      });

      return { ok: true, messageId: message.id, externalMessageId: externalId };
    } catch (error) {
      this.logger.error(
        `Failed to send message via provider: ${error.message}`,
      );
      await this.messageRepo.updateStatus(message.id, 'failed');
      throw error;
    }
  }

  /**
   * Get the reply window status for a conversation.
   * Used by the frontend to determine whether to lock the chat input.
   */
  getReplyWindowStatus(conversation: {
    channelType: string;
    lastCustomerMessageAt?: Date | null;
  }): {
    isOpen: boolean;
    channelType: string;
    lastCustomerMessageAt: string | null;
    expiresAt: string | null;
    remainingMs: number;
    windowHours: number;
  } {
    const channelKey =
      conversation.channelType.toLowerCase() as keyof typeof this.replyWindowCfg;
    const windowHours = this.replyWindowCfg[channelKey] ?? 24;

    // Unlimited window (e.g. LiveChat)
    if (windowHours === 0) {
      return {
        isOpen: true,
        channelType: conversation.channelType,
        lastCustomerMessageAt: conversation.lastCustomerMessageAt
          ? new Date(conversation.lastCustomerMessageAt).toISOString()
          : null,
        expiresAt: null,
        remainingMs: Infinity,
        windowHours: 0,
      };
    }

    // No customer message yet — window is closed
    if (!conversation.lastCustomerMessageAt) {
      return {
        isOpen: false,
        channelType: conversation.channelType,
        lastCustomerMessageAt: null,
        expiresAt: null,
        remainingMs: 0,
        windowHours,
      };
    }

    const lastMsg = new Date(conversation.lastCustomerMessageAt);
    const windowMs = windowHours * 60 * 60 * 1000;
    const expiresAt = new Date(lastMsg.getTime() + windowMs);
    const remainingMs = expiresAt.getTime() - Date.now();

    return {
      isOpen: remainingMs > 0,
      channelType: conversation.channelType,
      lastCustomerMessageAt: lastMsg.toISOString(),
      expiresAt: expiresAt.toISOString(),
      remainingMs: Math.max(0, remainingMs),
      windowHours,
    };
  }

  /**
   * Guard: throws ReplyWindowExpiredException if the platform reply window
   * has elapsed. Called before persisting or sending any free-form message.
   */
  private enforceReplyWindow(conversation: {
    channelType: string;
    lastCustomerMessageAt?: Date | null;
  }): void {
    const status = this.getReplyWindowStatus(conversation);
    if (!status.isOpen && status.windowHours > 0) {
      throw new ReplyWindowExpiredException(
        status.channelType,
        status.windowHours,
        conversation.lastCustomerMessageAt
          ? new Date(conversation.lastCustomerMessageAt)
          : new Date(0),
        status.expiresAt ? new Date(status.expiresAt) : new Date(),
      );
    }
  }

  /**
   * Send an email reply from the Agent to the Customer.
   * Processes S3 inline images natively via Axios streaming into Nodemailer CIDs.
   */
  async sendEmailReply(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    htmlBody: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: { url: string; filename: string; contentType: string }[];
  }): Promise<any> {
    const {
      tenantId,
      conversationId,
      agentId,
      to,
      cc = [],
      bcc = [],
      subject,
      htmlBody,
      inReplyTo,
      references = [],
      attachments: standardAttachments = [],
    } = params;

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // 1. Resolve SMTP config from TransportPool
    const channelId = conversation.channelId.toString();
    const transportConfig = await this.transportPool.resolveWithTenantGuard(
      channelId,
      tenantId,
    );

    if (!transportConfig || transportConfig.providerType !== 'smtp') {
      throw new Error('Invalid or missing SMTP configuration for this channel');
    }

    const { user, password } = transportConfig.credentials;
    const { host, port, fromEmail, fromName } = transportConfig.publicSettings;
    const numPort = Number(port);

    // ── Outbound Queue: Throttle + Daily Quota Check ──────────────────
    const throttleResult = await this.outboundQueue.checkSendAllowed(
      tenantId,
      channelId,
      host,
      to.length + cc.length + bcc.length,
    );
    if (!throttleResult.allowed) {
      throw new Error(throttleResult.reason || 'Send rate limited');
    }

    const transporter = nodemailer.createTransport({
      host,
      port: numPort,
      secure: numPort === 465,
      auth: { user, pass: password },
    });

    // 2. PARSE HTML & PROCESS CID INLINE IMAGES
    // Using cheerio for synchronous DOM manipulation
    // We MUST use for...of for asynchronous operations to avoid unhandled promises
    const $ = cheerio.load(htmlBody);
    const imagesToProcess = $('img').toArray();
    const inlineAttachments: any[] = [];

    for (const [index, el] of imagesToProcess.entries()) {
      const src = $(el).attr('src');
      if (src && src.includes('s3')) {
        // Matches any S3/storage URL
        const cid = `inline-${index}-${Date.now()}@crmsaudi.dev`;
        $(el).attr('src', `cid:${cid}`);

        try {
          // Streaming download from S3 straight into Nodemailer Attachment
          // This avoids the fatal RAM Exhaustion OOM Trap
          const response = await axios({
            method: 'get',
            url: src,
            responseType: 'stream',
          });

          inlineAttachments.push({
            cid,
            filename: `image-${index}.jpg`, // Optional, email clients rely more on CID
            content: response.data,
            contentType: response.headers['content-type'],
          });
        } catch (downloadErr) {
          this.logger.warn(
            `Failed to download inline image from ${src}: ${downloadErr.message}`,
          );
          // Fallback: If we couldn't download it, we leave the S3 URL to avoid breaking the email entirely
          $(el).attr('src', src);
        }
      }
    }

    // ── Append Email Signature + Signature Fence ───────────────────────
    const signature = await this.emailSignatureService.getSignature(
      tenantId,
      agentId,
      channelId,
    );
    const signatureHtml = signature?.htmlContent || '';
    const signatureFenceHtml =
      this.emailSignatureService.wrapWithSignatureFence(
        signatureHtml,
        conversationId,
      );
    // Append signature + fence to the bottom of the email body
    if ($('body').length) {
      $('body').append(signatureFenceHtml);
    } else {
      $.root().append(signatureFenceHtml);
    }

    const finalHtml = $.html();

    // Setup standardized standard attachments via streams as well
    const formattedAttachments: any[] = [];
    for (const attachment of standardAttachments) {
      try {
        const response = await axios({
          method: 'get',
          url: attachment.url,
          responseType: 'stream',
        });
        formattedAttachments.push({
          filename: attachment.filename,
          content: response.data,
          contentType: attachment.contentType,
        });
      } catch {
        this.logger.error(`Failed to download attachment ${attachment.url}`);
        throw new Error(
          `Could not fetch attachment ${attachment.filename} for email dispatch`,
        );
      }
    }

    const allAttachments = [...formattedAttachments, ...inlineAttachments];

    // 3. Persist placeholder to MessageRepository
    // We do this first so we have the Message ID
    const snippet =
      finalHtml
        .replace(/<[^>]*>?/gm, '')
        .substring(0, 200)
        .trim() || '(No content)';

    let messageRecord;
    try {
      messageRecord = await this.messageRepo.create({
        tenantId,
        conversationId,
        senderId: agentId,
        senderType: 'agent',
        messageType: 'text',
        content: snippet,
        status: 'sending',
      });
    } catch (dbErr) {
      throw new Error(`Failed to create message record: ${dbErr}`);
    }

    // 4. Send Email via NodeMailer
    let info;
    const fromAddress = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
    try {
      info = await transporter.sendMail({
        from: fromAddress,
        to,
        cc,
        bcc,
        subject,
        html: `<html><head><meta charset="utf-8"></head><body>${finalHtml}</body></html>`,
        text: snippet,
        attachments: allAttachments,
        inReplyTo: inReplyTo || undefined,
        references: references.length ? references.join(' ') : undefined,
        headers: {
          // Layer 1: Custom CRM Headers for Thread Correlation (Section 5.4)
          'X-CRM-Thread-ID': conversationId,
          'X-CRM-Tenant-ID': tenantId,
          'X-CRM-Message-Id': messageRecord.id,
        },
      });
    } catch (err) {
      this.logger.error(`Nodemailer failed to send email: ${err}`);
      await this.messageRepo.updateStatus(messageRecord.id, 'failed');
      throw err;
    }

    const externalId = info.messageId || `<${uuidv4()}@crm.local>`;

    // 5. Update Status + Record Send for Quota Tracking
    await this.messageRepo.updateStatus(messageRecord.id, 'sent', externalId);
    await this.conversationRepo.updateLastMessage(
      conversationId,
      snippet,
      new Date(),
      'agent',
    );

    // Record successful send for daily quota counter
    await this.outboundQueue.recordSend(
      tenantId,
      channelId,
      to.length + cc.length + bcc.length,
    );

    // 6. Save Email Full Content & Metadata
    await this.emailContentModel.create({
      tenantId,
      messageId: messageRecord.id,
      contactIds: [], // Would normally extract from all recipients
      subject,
      htmlBody: finalHtml,
      textBody: snippet,
      attachments: standardAttachments, // store metadata of standard attachments only
    });

    await this.emailMetadataModel.create({
      tenantId,
      mailboxId: channelId,
      messageId: messageRecord.id,
      emailMessageId: externalId,
      inReplyTo,
      references,
      from: fromAddress,
      to,
      cc,
      bcc,
      deliveryStatus: 'unknown',
    });

    // 7. Emit real-time socket event
    this.eventEmitter.emit('omni.message.sent', {
      tenantId,
      conversationId,
      senderId: agentId,
      senderType: 'agent',
      messageType: 'text',
      content: snippet, // For UI preview
      messageId: messageRecord.id,
      externalMessageId: externalId,
      status: 'sent',
      timestamp: new Date().toISOString(),
      source: 'http',
    });

    return {
      ok: true,
      messageId: messageRecord.id,
      externalMessageId: externalId,
    };
  }
}
