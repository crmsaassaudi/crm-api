import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Unprotected } from 'nest-keycloak-connect';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { OutboundService } from '../../omni-outbound/outbound.service';
import { BotCallbackPayload, BotReplyMessage } from './bot-processing.types';

/**
 * Receives async callback from crm-bot after it finishes processing a flow.
 * This replaces the old synchronous wait in BotProcessingProcessor.
 *
 * Flow: Bot processes flow → POST /v1/bot-callback/reply → this controller
 *       → save messages → send replies → handle handoff
 */
@Controller({ path: 'bot-callback', version: '1' })
export class BotCallbackController {
  private readonly logger = new Logger(BotCallbackController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly cls: ClsService,
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
    private readonly outboundService: OutboundService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Post('reply')
  @Unprotected()
  @HttpCode(200)
  async handleBotCallback(
    @Headers('x-crm-internal-secret') secret: string,
    @Body() payload: BotCallbackPayload,
  ) {
    this.validateInternalSecret(secret);

    const { conversationId, org } = payload;
    this.logger.log(
      `[BOT-CALLBACK] ▶ Received callback — conv=${conversationId}, org=${org}, ` +
        `inboundMsg=${payload.inboundMessageId}, sessionId=${payload.sessionId}, ` +
        `status=${payload.status}, handoff=${!!payload.handoff}, ` +
        `messages=${payload.messages?.length ?? 0}`,
    );

    if (payload.messages?.length) {
      payload.messages.forEach((m, i) => {
        this.logger.log(
          `[BOT-CALLBACK] Message[${i}]: type=${m.type}, ` +
            `text="${(m.text || '').substring(0, 80)}", ` +
            `buttons=${m.buttons?.length ?? 0}, url=${m.url ?? 'none'}`,
        );
      });
    }

    // Wrap in tenant context — Mongoose tenant-filter plugin needs activeTenantId in CLS
    return runWithTenantContext(this.cls, org, async () => {
      // 1. Validate conversation exists and belongs to tenant
      const conversation = await this.conversationRepo.findById(conversationId);
      if (!conversation) {
        this.logger.warn(
          `[BOT-CALLBACK] ✗ Conversation ${conversationId} NOT FOUND — ignoring callback`,
        );
        return { ok: true, ignored: true };
      }
      if (conversation.tenantId !== org) {
        this.logger.error(
          `[BOT-CALLBACK] ✗ Tenant mismatch: conv.tenant=${conversation.tenantId}, payload.org=${org}`,
        );
        throw new ForbiddenException('Tenant mismatch');
      }

      this.logger.log(
        `[BOT-CALLBACK] Conversation validated — channel=${conversation.channelType}, ` +
          `status=${conversation.status}, bot=${JSON.stringify(conversation.bot ?? null)}`,
      );

      // 2. Update bot state (sessionId, status)
      if (
        payload.sessionId &&
        payload.sessionId !== conversation.bot?.sessionId
      ) {
        this.logger.log(
          `[BOT-CALLBACK] Updating bot sessionId: ${conversation.bot?.sessionId} → ${payload.sessionId}, status=${payload.status ?? 'active'}`,
        );
        await this.conversationRepo.updateBotState(conversationId, {
          sessionId: payload.sessionId,
          status: payload.status ?? 'active',
          lastError: null,
        });
      } else if (payload.status) {
        this.logger.log(
          `[BOT-CALLBACK] Updating bot status: ${conversation.bot?.status} → ${payload.status}`,
        );
        await this.conversationRepo.updateBotState(conversationId, {
          status: payload.status,
          lastError: null,
        });
      }

      // 3. Send bot messages to customer
      for (const [index, message] of (payload.messages ?? []).entries()) {
        this.logger.log(
          `[BOT-CALLBACK] Sending message[${index}]: type=${message.type}, ` +
            `buttons=${message.buttons?.length ?? 0}`,
        );
        try {
          await this.sendBotMessage(
            org,
            conversationId,
            payload.inboundMessageId,
            message,
            index,
          );
          this.logger.log(
            `[BOT-CALLBACK] ✓ Message[${index}] sent successfully`,
          );
        } catch (err) {
          this.logger.error(
            `[BOT-CALLBACK] ✗ Message[${index}] FAILED: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      }

      // 4. Handle handoff / ended
      if (payload.handoff || payload.status === 'handoff') {
        this.logger.log(
          `[BOT-CALLBACK] Handling HANDOFF for conv=${conversationId}`,
        );
        await this.handleHandoff(org, conversationId);
      } else if (payload.status === 'ended') {
        this.logger.log(
          `[BOT-CALLBACK] Bot flow ENDED for conv=${conversationId}`,
        );
        await this.conversationRepo.updateBotState(conversationId, {
          enabled: false,
          status: 'ended',
        });
      }

      this.logger.log(
        `[BOT-CALLBACK] ✓ Callback processed successfully — conv=${conversationId}`,
      );
      return { ok: true };
    });
  }

  private validateInternalSecret(secret: string): void {
    const expected = this.configService.get<string>('CRM_BOT_INTERNAL_SECRET', {
      infer: true,
    });
    if (!expected) {
      this.logger.warn(
        'CRM_BOT_INTERNAL_SECRET not configured — skipping validation',
      );
      return;
    }
    if (secret !== expected) {
      throw new ForbiddenException('Invalid internal secret');
    }
  }

  private async sendBotMessage(
    tenantId: string,
    conversationId: string,
    inboundMessageId: string,
    message: BotReplyMessage,
    index: number,
  ): Promise<void> {
    const idempotencyKey = `bot:${inboundMessageId}:${index}`;

    switch (message.type) {
      case 'text': {
        // Text message — may include interactive buttons.
        //
        // Typebot attaches choice-input buttons to the LAST text bubble,
        // so buttons always arrive on a type="text" message.
        // outbound.sendBotMessage() detects buttons and auto-routes:
        //   buttons present + adapter.sendInteractive → WhatsApp interactive buttons
        //   buttons present + no sendInteractive      → numbered text fallback
        //   no buttons                                → plain text
        const content = message.text?.trim();
        if (!content) return;

        await this.outboundService.sendBotMessage({
          tenantId,
          conversationId,
          content,
          messageType: 'text',
          buttons: message.buttons,
          idempotencyKey,
        });
        break;
      }

      case 'image':
      case 'video':
      case 'audio':
      case 'file': {
        // Media message — download from bot URL → upload via channel adapter
        if (!message.url) {
          this.logger.warn(`Bot ${message.type} message has no URL — skipping`);
          return;
        }

        await this.outboundService.sendBotMedia({
          tenantId,
          conversationId,
          mediaUrl: message.url,
          mediaType: message.type,
          mimeType: message.mimeType,
          caption: message.text?.trim(),
          idempotencyKey,
        });
        break;
      }

      default:
        this.logger.warn(
          `Unknown bot message type="${message.type}" — skipping`,
        );
    }
  }

  private async handleHandoff(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    await this.conversationRepo.markBotHandoff(conversationId);

    const systemMessage = await this.messageRepo.create({
      tenantId,
      conversationId,
      senderId: 'system',
      senderName: 'System',
      senderType: 'system',
      direction: 'internal',
      source: 'bot',
      messageType: 'text',
      content: 'Đang chuyển tư vấn viên',
      status: 'delivered',
      metadata: {
        event: 'bot_handoff',
        provider: 'typebot',
      },
    });

    await this.conversationRepo.updateLastMessage(
      conversationId,
      systemMessage.content,
      new Date(),
      'system',
    );

    this.eventEmitter.emit('omni.message.sent', {
      tenantId,
      conversationId,
      senderId: 'system',
      senderName: 'System',
      senderType: 'system',
      direction: 'internal',
      source: 'bot',
      messageType: 'text',
      content: systemMessage.content,
      messageId: systemMessage.id,
      status: 'delivered',
      timestamp: new Date().toISOString(),
      transport: 'http',
      metadata: systemMessage.metadata,
    });
  }
}
