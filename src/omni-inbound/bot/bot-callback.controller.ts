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
import { BotCallbackPayload } from './bot-processing.types';
import { BotGeneratedReplyEvent } from '../aggregate/conversation-command.types';
import { BOT_GENERATED_REPLY_EVENT } from '../aggregate/conversation-ops.constants';

/**
 * Receives async callback from crm-bot after it finishes processing a flow.
 *
 * ── Aggregate Architecture (Phase 1) ──
 * This controller NO LONGER performs any direct DB mutations.
 * It validates the request, then emits a `bot.generated_reply` event
 * which is consumed by ConversationCommandService and converted into
 * a BOT_REPLY command processed sequentially by ConversationOpsProcessor.
 *
 * This decoupling:
 * - Eliminates race conditions between bot replies and customer messages
 * - Allows future bot sources (AI Agent, Flow Builder) to use the same pattern
 * - Ensures all mutations go through the Conversation Aggregate Root
 */
@Controller({ path: 'bot-callback', version: '1' })
export class BotCallbackController {
  private readonly logger = new Logger(BotCallbackController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly cls: ClsService,
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
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
            `text="${(m.text ?? '').substring(0, 80)}", ` +
            `buttons=${m.buttons?.length ?? 0}, url=${m.url ?? 'none'}`,
        );
      });
    }

    // Wrap in tenant context — Mongoose tenant-filter plugin needs activeTenantId in CLS
    return runWithTenantContext(this.cls, org, async () => {
      // 1. Validate conversation exists and belongs to tenant (read-only)
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

      // 2. Resolve afterTimestamp from inbound message for causal ordering
      let afterTimestamp: number | undefined;
      try {
        const [inboundMsg] = await this.messageRepo.findByIds([
          payload.inboundMessageId,
        ]);
        if (inboundMsg?.providerTimestamp) {
          afterTimestamp = new Date(inboundMsg.providerTimestamp).getTime();
        }
      } catch {
        // Non-fatal — bot messages will use current server time
      }

      // 3. Emit event → ConversationCommandService → BOT_REPLY command → Processor
      // NO direct mutations here — everything is handled by the Aggregate
      const event: BotGeneratedReplyEvent = {
        conversationId,
        tenantId: org,
        messages: payload.messages ?? [],
        handoff: !!payload.handoff,
        handoffMeta: payload.handoffMeta,
        sessionId: payload.sessionId,
        status: payload.status ?? 'active',
        inboundMessageId: payload.inboundMessageId,
        afterTimestamp,
      };

      this.eventEmitter.emit(BOT_GENERATED_REPLY_EVENT, event);

      this.logger.log(
        `[BOT-CALLBACK] ✓ Emitted ${BOT_GENERATED_REPLY_EVENT} — conv=${conversationId}, ` +
          `msgs=${event.messages.length}, handoff=${event.handoff}`,
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
}
