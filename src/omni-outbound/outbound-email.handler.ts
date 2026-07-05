import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as nodemailer from 'nodemailer';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { ulid } from 'ulid';
import { MessageRepository } from '../omni-inbound/repositories/message.repository';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { TransportPoolService } from '../channels/transport-pool.service';
import { OutboundQueueService } from '../channels/services/outbound-queue.service';
import { EmailSignatureService } from '../channels/services/email-signature.service';
import { UsersService } from '../users/users.service';
import { EmailContentDocument } from '../channels/infrastructure/persistence/document/entities/email-content.schema';
import { EmailMetadataDocument } from '../channels/infrastructure/persistence/document/entities/email-metadata.schema';

/**
 * T-041: OutboundEmailHandler
 *
 * Extracted from OutboundService to isolate email/SMTP-specific concerns:
 * - SMTP transport resolution
 * - Outbound throttle & daily quota check
 * - HTML parsing + CID inline image embedding (cheerio)
 * - Email signature append
 * - Nodemailer send
 * - EmailContent + EmailMetadata persistence
 *
 * Reduces OutboundService by ~290 lines.
 */
@Injectable()
export class OutboundEmailHandler {
  private readonly logger = new Logger(OutboundEmailHandler.name);

  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly transportPool: TransportPoolService,
    private readonly outboundQueue: OutboundQueueService,
    private readonly emailSignatureService: EmailSignatureService,
    private readonly usersService: UsersService,
    @InjectModel('EmailContentSchemaClass')
    private readonly emailContentModel: Model<EmailContentDocument>,
    @InjectModel('EmailMetadataSchemaClass')
    private readonly emailMetadataModel: Model<EmailMetadataDocument>,
  ) {}

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
    const senderContext = await this.resolveSenderContext(agentId);

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
      throw new Error(throttleResult.reason ?? 'Send rate limited');
    }

    const transporter = nodemailer.createTransport({
      host,
      port: numPort,
      secure: numPort === 465,
      auth: { user, pass: password },
    });

    // 2. PARSE HTML & PROCESS CID INLINE IMAGES
    const { $, inlineAttachments } =
      await this.processHtmlWithInlineImages(htmlBody);

    // ── Append Email Signature + Signature Fence ───────────────────────
    await this.appendEmailSignature(
      $,
      tenantId,
      agentId,
      channelId,
      conversationId,
    );
    const finalHtml = $.html();

    // 3. Setup standard attachments via streams
    const formattedAttachments =
      await this.fetchStandardAttachments(standardAttachments);
    const allAttachments = [...formattedAttachments, ...inlineAttachments];

    // 4. Persist placeholder to MessageRepository
    const snippet = this.extractSnippet(finalHtml);
    const messageRecord = await this.persistOutboundMessage({
      tenantId,
      conversationId,
      agentId,
      senderContext,
      snippet,
    });

    // 5. Send Email via NodeMailer
    const fromAddress = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
    let info;
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
        inReplyTo: inReplyTo ?? undefined,
        references: references.length ? references.join(' ') : undefined,
        headers: {
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

    const externalId = info.messageId ?? `<${ulid()}@crm.local>`;

    // 6. Update Status + Record Send for Quota Tracking
    await this.messageRepo.updateStatus(messageRecord.id, 'sent', externalId);
    await this.conversationRepo.updateLastMessage(
      conversationId,
      snippet,
      new Date(),
      'agent',
    );
    await this.outboundQueue.recordSend(
      tenantId,
      channelId,
      to.length + cc.length + bcc.length,
    );

    // 7. Persist Email Full Content & Metadata
    await this.persistEmailContent({
      tenantId,
      messageId: messageRecord.id,
      subject,
      finalHtml,
      snippet,
      standardAttachments,
    });
    await this.persistEmailMetadata({
      tenantId,
      channelId,
      messageId: messageRecord.id,
      externalId,
      inReplyTo,
      references,
      fromAddress,
      to,
      cc,
      bcc,
    });

    // 8. Emit real-time socket event
    this.eventEmitter.emit('omni.message.sent', {
      tenantId,
      conversationId,
      senderId: agentId,
      senderName: senderContext.name,
      senderAvatarUrl: senderContext.avatarUrl ?? null,
      senderType: 'agent',
      messageType: 'text',
      content: snippet,
      messageId: messageRecord.id,
      externalMessageId: externalId,
      status: 'sent',
      timestamp: new Date().toISOString(),
      source: 'crm_api',
      transport: 'http',
    });

    return {
      ok: true,
      messageId: messageRecord.id,
      externalMessageId: externalId,
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /** Parse HTML, download S3 inline images, and embed as CID attachments. */
  private async processHtmlWithInlineImages(
    htmlBody: string,
  ): Promise<{ $: ReturnType<typeof cheerio.load>; inlineAttachments: any[] }> {
    const $ = cheerio.load(htmlBody);
    const imagesToProcess = $('img').toArray();
    const inlineAttachments: any[] = [];

    for (const [index, el] of imagesToProcess.entries()) {
      const src = $(el).attr('src');
      if (src?.includes('s3')) {
        const cid = `inline-${index}-${Date.now()}@crmsaudi.dev`;
        $(el).attr('src', `cid:${cid}`);
        try {
          const response = await axios({
            method: 'get',
            url: src,
            responseType: 'stream',
          });
          inlineAttachments.push({
            cid,
            filename: `image-${index}.jpg`,
            content: response.data,
            contentType: response.headers['content-type'],
          });
        } catch (downloadErr: unknown) {
          const errorMessage =
            downloadErr instanceof Error
              ? downloadErr.message
              : String(downloadErr);
          this.logger.warn(
            `Failed to download inline image from ${src}: ${errorMessage}`,
          );
          $(el).attr('src', src);
        }
      }
    }

    return { $, inlineAttachments };
  }

  /** Append tenant/agent email signature to the document. */
  private async appendEmailSignature(
    $: ReturnType<typeof cheerio.load>,
    tenantId: string,
    agentId: string,
    channelId: string,
    conversationId: string,
  ): Promise<void> {
    const signature = await this.emailSignatureService.getSignature(
      tenantId,
      agentId,
      channelId,
    );
    const signatureHtml = signature?.htmlContent ?? '';
    const signatureFenceHtml =
      this.emailSignatureService.wrapWithSignatureFence(
        signatureHtml,
        conversationId,
      );
    if ($('body').length) {
      $('body').append(signatureFenceHtml);
    } else {
      $.root().append(signatureFenceHtml);
    }
  }

  /** Download standard attachment files from remote URLs. */
  private async fetchStandardAttachments(
    attachments: { url: string; filename: string; contentType: string }[],
  ): Promise<any[]> {
    const result: any[] = [];
    for (const attachment of attachments) {
      try {
        const response = await axios({
          method: 'get',
          url: attachment.url,
          responseType: 'stream',
        });
        result.push({
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
    return result;
  }

  /** Strip HTML tags and return the first 200 characters as a plain-text snippet. */
  private extractSnippet(html: string): string {
    return (
      html
        .replace(/<[^>]*>?/gm, '')
        .substring(0, 200)
        .trim() || '(No content)'
    );
  }

  /** Persist an outbound message record and return it. */
  private async persistOutboundMessage(opts: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    senderContext: { name: string; avatarUrl?: string | null };
    snippet: string;
  }): Promise<any> {
    const { tenantId, conversationId, agentId, senderContext, snippet } = opts;
    try {
      return await this.messageRepo.create({
        tenantId,
        conversationId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? undefined,
        senderType: 'agent',
        direction: 'outbound',
        source: 'crm_api',
        messageType: 'text',
        content: snippet,
        status: 'sending',
        metadata: {
          sender: {
            id: agentId,
            name: senderContext.name,
            avatarUrl: senderContext.avatarUrl ?? null,
            type: 'agent',
          },
          source: 'crm_api',
        },
      });
    } catch (dbErr) {
      throw new Error(`Failed to create message record: ${dbErr}`);
    }
  }

  /** Persist EmailContent document. */
  private async persistEmailContent(opts: {
    tenantId: string;
    messageId: string;
    subject: string;
    finalHtml: string;
    snippet: string;
    standardAttachments: any[];
  }): Promise<void> {
    await this.emailContentModel.create({
      tenantId: opts.tenantId,
      messageId: opts.messageId,
      contactIds: [],
      subject: opts.subject,
      htmlBody: opts.finalHtml,
      textBody: opts.snippet,
      attachments: opts.standardAttachments,
    });
  }

  /** Persist EmailMetadata document. */
  private async persistEmailMetadata(opts: {
    tenantId: string;
    channelId: string;
    messageId: string;
    externalId: string;
    inReplyTo?: string;
    references: string[];
    fromAddress: string;
    to: string[];
    cc: string[];
    bcc: string[];
  }): Promise<void> {
    await this.emailMetadataModel.create({
      tenantId: opts.tenantId,
      mailboxId: opts.channelId,
      messageId: opts.messageId,
      emailMessageId: opts.externalId,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      from: opts.fromAddress,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      deliveryStatus: 'unknown',
    });
  }

  // ── Shared Helpers ──────────────────────────────────────────────────────

  private async resolveSenderContext(agentId: string): Promise<{
    name: string;
    avatarUrl?: string | null;
  }> {
    try {
      const users = await this.usersService.findByIdsGlobal([agentId]);
      const user = users[0];
      if (!user) return { name: 'Agent', avatarUrl: null };

      const fullName = [user.firstName, user.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();

      return {
        name: (fullName || user.email) ?? 'Agent',
        avatarUrl: user.photo?.path ?? null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to resolve sender context for agent ${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { name: 'Agent', avatarUrl: null };
    }
  }
}
