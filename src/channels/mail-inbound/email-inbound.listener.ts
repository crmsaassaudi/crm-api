import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { OmniPayload } from '../../omni-inbound/domain/omni-payload';

/**
 * EmailInboundListener — Bridges email.inbound.received events
 * into the standard omni.message.received pipeline.
 */
@Injectable()
export class EmailInboundListener {
  private readonly logger = new Logger(EmailInboundListener.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  @OnEvent('email.inbound.received')
  handleEmailInbound(event: {
    tenantId: string;
    configId: string;
    channelType: 'email';
    generatedMessageId: string;
    from: string;
    fromName: string;
    to: string[];
    cc: string[];
    subject: string;
    snippet: string;
    threadInfo: {
      messageId: string | null;
      inReplyTo: string | null;
      references: string[];
    };
    emailContentId: string;
    emailMetadataId: string;
    mailboxId?: string;
    crmFolder?: string | null;
    providerFolder?: string | null;
    providerLabelIds?: string[];
    providerLabels?: string[];
    providerLabelDetails?: Array<{
      id: string;
      name: string;
      type: 'system' | 'user';
      color: string | null;
    }>;
    timestamp: Date;
  }): void {
    this.logger.log(
      `[EmailInbound] Processing: "${event.subject}" from ${event.fromName} <${event.from}>`,
    );

    const payload: OmniPayload = {
      tenantId: event.tenantId,
      channelId: event.configId,
      channelAccount: event.configId,
      channelType: 'email',

      senderId: event.from,
      senderType: 'customer',
      messageType: 'text',

      // Subject + clean snippet (no CSS/HTML artifacts)
      content: event.subject
        ? `${event.subject}`
        : event.snippet || '(no content)',

      metadata: {
        emailContentId: event.emailContentId,
        emailMetadataId: event.emailMetadataId,
        generatedMessageId: event.generatedMessageId,
        mailboxId: event.mailboxId,
        crmFolder: event.crmFolder,
        providerFolder: event.providerFolder,
        providerLabelIds: event.providerLabelIds ?? [],
        providerLabels: event.providerLabels ?? [],
        providerLabelDetails: event.providerLabelDetails ?? [],
        subject: event.subject,
        from: event.from,
        fromName: event.fromName,
        to: event.to,
        cc: event.cc,
        threadInfo: event.threadInfo,
        contactName: event.fromName,
      },

      externalMessageId: event.threadInfo.messageId ?? event.generatedMessageId,

      // CRIT-04: Use references[0] as the thread key — it's the root
      // Message-ID and is constant across the entire email thread.
      // inReplyTo differs for every reply, which scattered threads
      // across multiple conversations.
      externalConversationId:
        event.threadInfo.references?.[0] ??
        event.threadInfo.messageId ??
        `email:${event.from}:${event.configId}`,

      timestamp: event.timestamp,
      providerTimestamp: event.timestamp,
    };

    this.eventEmitter.emit('omni.message.received', payload);

    this.logger.log(
      `[EmailInbound] ✅ Forwarded: "${event.subject}" from ${event.fromName}`,
    );
  }
}
