import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConversationRepository } from '../repositories/conversation.repository';

export interface ContactVipChangedEvent {
  tenantId: string;
  contactId: string;
  isVip: boolean;
}

/**
 * Keeps `omni_conversations.isVip` in step with `contacts.isVIP`.
 *
 * Lives on the omni side and listens rather than being called: omni-inbound
 * already depends on contacts, so the reverse call would close a cycle in the
 * module graph — the failure this codebase has already paid for once (a DI cycle
 * that hung bootstrap for hours). An event crosses the boundary in the direction
 * that has no edge.
 *
 * Eventual by design. The window between a contact being flagged VIP and its
 * live conversations carrying the flag is one event loop turn; a conversation
 * that arrives during it is stamped from `isVIPSender` at creation, so neither
 * path depends on the other having run.
 */
@Injectable()
export class ContactVipSyncListener {
  private readonly logger = new Logger(ContactVipSyncListener.name);

  constructor(private readonly conversations: ConversationRepository) {}

  @OnEvent('contact.vip_changed')
  async onVipChanged(event: ContactVipChangedEvent): Promise<void> {
    if (!event?.tenantId || !event?.contactId) return;
    try {
      const updated = await this.conversations.syncVipForContact({
        tenantId: event.tenantId,
        contactId: event.contactId,
        isVip: event.isVip === true,
      });
      if (updated > 0) {
        this.logger.log(
          `Contact ${event.contactId} VIP=${event.isVip}: updated ${updated} live conversation(s)`,
        );
      }
    } catch (error: any) {
      // Never rethrow into the emitter: a failed denormalisation must not fail
      // the contact update that triggered it. The flag is re-derived for every
      // new conversation, so a miss here degrades the filter for existing
      // threads rather than losing the change.
      this.logger.error(
        `Failed to sync VIP flag for contact ${event.contactId}: ${error?.message}`,
      );
    }
  }
}
