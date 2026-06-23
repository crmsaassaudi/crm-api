import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OmniEvents } from '../domain/omni-events';
import { ConversationRepository } from '../repositories/conversation.repository';
import { IdentityService } from './identity.service';
import { InboundOrchestrationService } from './inbound-orchestration.service';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';

/**
 * ConversationLifecycleService — manages conversation session lifecycle.
 *
 * Responsibilities:
 * - Session lifecycle configuration (reopen window, auto-resolve, OOO)
 * - Status change event handling (identity cache invalidation, agent release)
 * - Channel type normalization
 *
 * Extracted from ConversationService to:
 * - Separate lifecycle concerns from inbound message processing
 * - Allow ConversationService to delegate lifecycle config reads
 * - Reduce ConversationService dependency count
 */
@Injectable()
export class ConversationLifecycleService {
  private readonly logger = new Logger(ConversationLifecycleService.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly identityService: IdentityService,
    private readonly orchestration: InboundOrchestrationService,
    private readonly settingsService: CrmSettingsService,
  ) {}

  // ────────────────────────────────────────────────────────────────
  // Session Lifecycle Configuration
  // ────────────────────────────────────────────────────────────────

  /**
   * Load session lifecycle configuration from tenant CRM settings.
   * Falls back to sensible defaults if not configured.
   */
  async getSessionLifecycleConfig(): Promise<{
    reopenWindowHours: number;
    autoResolveTimeoutHours: number;
    autoResolveEnabled: boolean;
    oooAutoReplyEnabled: boolean;
    oooMessage: string;
    oooSetPending: boolean;
  }> {
    const defaults = {
      reopenWindowHours: 24,
      autoResolveTimeoutHours: 48,
      autoResolveEnabled: true,
      oooAutoReplyEnabled: false,
      oooMessage:
        'Thank you for your message! Our team is currently offline. We will get back to you during business hours.',
      oooSetPending: true,
    };

    try {
      const config = await this.settingsService.getSetting(
        'omni_session_lifecycle',
      );
      return config ? { ...defaults, ...config } : defaults;
    } catch (err: any) {
      this.logger.warn(
        `Failed to load omni_session_lifecycle settings: ${err.message}`,
      );
      return defaults;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Event listeners for cache invalidation
  // ────────────────────────────────────────────────────────────────

  /**
   * When a conversation is resolved or closed, invalidate the identity cache
   * so the next inbound message creates a NEW session.
   *
   * Also:
   * - Cancels any pending auto-resolve job
   * - Releases the agent's conversation counter (capacity tracking)
   */
  @OnEvent(OmniEvents.CONVERSATION_STATUS_CHANGED)
  async handleStatusChanged(event: {
    tenantId: string;
    conversationId: string;
    status: string;
    agentId?: string | null;
    channelType: string;
    channelAccount: string;
    externalConversationId: string;
  }): Promise<void> {
    if (event.status === 'resolved' || event.status === 'closed') {
      await this.identityService.invalidateIdentity(
        event.channelType,
        event.channelAccount,
        event.externalConversationId,
        event.tenantId,
      );

      // Cancel any pending auto-resolve job for this conversation
      await this.orchestration.cancelAutoResolve(event.conversationId);

      const assignedAgentId =
        (await this.conversationRepo.findById(event.conversationId))
          ?.assignedAgentId ?? null;
      if (assignedAgentId) {
        await this.orchestration.releaseConversation(
          event.tenantId,
          assignedAgentId,
        );
      }

      this.logger.log(
        `Invalidated identity cache for conversation ${event.conversationId} (${event.status})`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────

  /**
   * Normalize channel type string for schema storage.
   */
  toSchemaChannelType(type: string): string {
    return type.toLowerCase();
  }
}
