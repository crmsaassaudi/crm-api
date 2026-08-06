import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConversationRepository } from '../repositories/conversation.repository';
import { ContactsService } from '../../contacts/contacts.service';
import { OmniEvents } from '../domain/omni-events';
import {
  normalizeEmail,
  normalizePhone,
} from '../../common/identity/identity-normalizer';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';

/**
 * ConversationIdentityService — attach a conversation to a CRM contact.
 *
 * The inbox offers an agent two ways to do this on an unlinked conversation:
 * "Save lead" (create a contact from what the channel told us) and "Merge
 * contact" (link to one that already exists). Neither worked. The first button
 * had no `onClick` at all; the second POSTed to
 * `/contacts/:id/link-identity`, a route that does not exist anywhere in the API,
 * so it 404'd and showed a generic "merge failed".
 *
 * Both now land here. Linking carries the channel identity across too — without
 * that, the next message from the same sender resolves to nothing and creates a
 * fresh shadow contact, undoing the link the agent just made.
 */
@Injectable()
export class ConversationIdentityService {
  private readonly logger = new Logger(ConversationIdentityService.name);

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly contacts: ContactsService,
    private readonly settings: CrmSettingsService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Link a conversation to an existing contact.
   *
   * @returns the linked contact id.
   */
  async linkToContact(
    conversationId: string,
    contactId: string,
    actorId: string,
  ): Promise<{ contactId: string }> {
    // Both reads go through their repositories, so a caller cannot link records
    // they are not allowed to see.
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new NotFoundException('Conversation not found');

    const contact = await this.contacts.findOne(contactId);
    if (!contact) throw new NotFoundException('Contact not found');

    await this.conversations.updateContactId(conversationId, contactId);
    await this.carryIdentityAcross(conversation, contactId);

    this.events.emit(OmniEvents.CONTACT_AUTO_MERGED, {
      tenantId: conversation.tenantId,
      conversationId,
      existingContactId: contactId,
      senderId: conversation.customer?.externalId,
      channelType: conversation.channelType,
      matchedBy: 'agent',
      agentId: actorId,
    });

    this.logger.log(
      `Conversation ${conversationId} linked to contact ${contactId} by ${actorId}`,
    );
    return { contactId };
  }

  /**
   * Create a contact from the conversation's customer details and link it.
   *
   * Everything the channel volunteered — name, phone, email, the channel identity
   * itself — so the new contact is immediately findable by the same lookups that
   * dedupe inbound senders, rather than being a name with nothing to match on.
   */
  async createAndLinkContact(
    conversationId: string,
    actorId: string,
  ): Promise<{ contactId: string }> {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.contactId) {
      // Already linked: return the existing contact rather than creating a
      // duplicate for an agent who double-clicked.
      return { contactId: conversation.contactId };
    }

    const customer = conversation.customer ?? ({} as any);
    const displayName = (customer.name ?? '').trim();
    const [firstName, ...rest] = displayName
      ? displayName.split(/\s+/)
      : [customer.externalId ?? 'Customer'];

    const countryCode = await this.defaultCountryCode(conversation.tenantId);
    const phone = customer.phone
      ? normalizePhone(customer.phone, countryCode)
      : undefined;
    const email = customer.email ? normalizeEmail(customer.email) : undefined;

    const contact = await this.contacts.create({
      tenantId: conversation.tenantId,
      firstName,
      lastName: rest.join(' ') || '',
      emails: email ? [email] : [],
      phones: phone ? [phone] : [],
      status: 'new',
      lifecycleStage: 'lead',
      source: conversation.channelType,
      omniIdentities: [
        {
          channelType: conversation.channelType,
          senderId: customer.externalId,
        },
      ],
      createdById: actorId,
      updatedById: actorId,
    } as any);

    await this.conversations.updateContactId(conversationId, contact.id);
    this.logger.log(
      `Conversation ${conversationId} saved as new contact ${contact.id} by ${actorId}`,
    );
    return { contactId: contact.id };
  }

  /**
   * Make sure the contact owns this channel identity.
   *
   * Best-effort: the identity may already be there (the agent re-linking the same
   * pair), and a duplicate-key error means the job is already done.
   */
  private async carryIdentityAcross(
    conversation: { channelType: string; customer?: { externalId?: string } },
    contactId: string,
  ): Promise<void> {
    const senderId = conversation.customer?.externalId;
    if (!senderId) return;
    try {
      await this.contacts.mergeIdentity(contactId, {
        channelType: conversation.channelType,
        senderId,
      });
    } catch (error) {
      this.logger.debug(
        `Identity ${conversation.channelType}:${senderId} already on contact ${contactId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async defaultCountryCode(
    tenantId: string,
  ): Promise<string | undefined> {
    try {
      const identity = await this.settings.getSetting(
        'contact_identity',
        tenantId,
      );
      return identity?.defaultCountryCode;
    } catch {
      return undefined;
    }
  }
}
