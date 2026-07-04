import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ContactsService } from '../contacts/contacts.service';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { IdentityService } from '../omni-inbound/services/identity.service';
import { LivechatWidgetService } from './livechat-widget.service';
import {
  OmniEvents,
  LivechatVisitorIdentifiedEvent,
} from '../omni-inbound/domain/omni-events';

/**
 * ContactEnrichmentService — maps pre-chat form data to CRM Contact entity.
 *
 * Resolves the Gap-1 bug where visitor:identify only updated the
 * OmniConversation.customer subdocument but never enriched the Contact.
 *
 * Flow:
 *   1. Load WidgetConfig → read field-level `contactField` mapping rules
 *   2. Build Contact update payload from form data + mapping rules
 *   3. Find existing Contact (via conversation.contactId or email/phone dedup)
 *   4. Update or create Contact with mapped fields
 *   5. Ensure Conversation.contactId ↔ Contact.id (1:1 link)
 *   6. Broadcast update so CRM agent panel refreshes in realtime
 */
@Injectable()
export class ContactEnrichmentService {
  private readonly logger = new Logger(ContactEnrichmentService.name);

  /** Built-in Contact fields that can be mapped from pre-chat form */
  static readonly BUILTIN_CONTACT_FIELDS = [
    { key: 'firstName', label: 'Họ', type: 'string' },
    { key: 'lastName', label: 'Tên', type: 'string' },
    { key: 'emails', label: 'Email', type: 'array' },
    { key: 'phones', label: 'Số điện thoại', type: 'array' },
    { key: 'companyName', label: 'Công ty', type: 'string' },
    { key: 'title', label: 'Chức vụ', type: 'string' },
    { key: 'role', label: 'Vai trò', type: 'string' },
    { key: 'address', label: 'Địa chỉ', type: 'string' },
  ] as const;

  constructor(
    private readonly contactsService: ContactsService,
    private readonly conversationRepo: ConversationRepository,
    private readonly identityService: IdentityService,
    private readonly widgetService: LivechatWidgetService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Enrich a CRM Contact from pre-chat form submission.
   *
   * Steps:
   *   1. Load widget config → get field mapping rules (contactField per field)
   *   2. Build Contact update object from mapping rules
   *   3. Resolve existing Contact (conversation.contactId or email/phone dedup)
   *   4. Update existing Contact OR create new one
   *   5. Ensure Conversation.contactId = Contact.id (1:1 link)
   *   6. Broadcast changes for CRM realtime update
   */
  async enrichFromPreChat(
    event: LivechatVisitorIdentifiedEvent,
  ): Promise<void> {
    const {
      tenantId,
      visitorId,
      channelId,
      widgetId,
      conversationId,
      identityData,
    } = event;

    if (!identityData || Object.keys(identityData).length === 0) {
      this.logger.debug(
        `No identity data for visitor ${visitorId} — skipping enrichment`,
      );
      return;
    }

    try {
      // ── Step 1: Load widget config for field mapping rules ──────────
      const fieldMappings = await this.loadFieldMappings(widgetId);

      // ── Step 2: Build Contact update from mapping rules ─────────────
      const { contactUpdate, email, phone, displayName } =
        this.buildContactUpdate(identityData, fieldMappings);

      // ── Step 3: Resolve existing Contact ────────────────────────────
      let contactId: string | null = null;

      if (conversationId) {
        const conversation =
          await this.conversationRepo.findById(conversationId);
        contactId = conversation?.contactId ?? null;
      }

      // ── Step 3a: If we already have a contactId, enrich it ──────────
      if (contactId) {
        await this.enrichExistingContact(
          contactId,
          contactUpdate,
          email,
          phone,
        );
        this.logger.log(
          `Enriched existing Contact ${contactId} from pre-chat form`,
        );
      } else {
        // ── Step 3b: Search by email/phone dedup ──────────────────────
        contactId = await this.findOrCreateContact(
          tenantId,
          visitorId,
          contactUpdate,
          email,
          phone,
          displayName,
        );
      }

      // ── Step 5: Link Conversation ↔ Contact (1:1) ──────────────────
      if (conversationId && contactId) {
        await this.conversationRepo.updateContactId(conversationId, contactId);

        // Also update conversation.customer for display consistency
        await this.conversationRepo.updateCustomerInfo(conversationId, {
          ...(displayName ? { name: displayName } : {}),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
        });

        // Update identity cache
        await this.identityService.updateIdentity(
          'livechat',
          channelId,
          visitorId,
          { contactId, conversationId },
          tenantId,
        );

        // ── Step 6: Broadcast for CRM realtime update ──────────────────
        this.eventEmitter.emit(OmniEvents.CONVERSATION_CUSTOMER_UPDATED, {
          tenantId,
          conversationId,
          contactId,
        });

        this.logger.log(
          `Linked Contact ${contactId} ↔ Conversation ${conversationId} (1:1)`,
        );
      }

      // ── Step 5b: Cache contactId even WITHOUT conversation ────────
      // When visitor submits pre-chat form before their first message,
      // conversationId is null. We still cache the contactId so that
      // ConversationService picks it up when the first message arrives
      // and creates the conversation linked to the correct contact
      // instead of creating a duplicate shadow contact.
      if (!conversationId && contactId) {
        await this.identityService.updateIdentity(
          'livechat',
          channelId,
          visitorId,
          { contactId, conversationId: null },
          tenantId,
        );
        this.logger.log(
          `Cached Contact ${contactId} for visitor ${visitorId} (no conversation yet)`,
        );
      }
    } catch (err: any) {
      // Enrichment failure must NOT block the chat flow
      this.logger.error(
        `Contact enrichment failed for visitor ${visitorId}: ${err.message}`,
        err.stack,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Load field definitions from widget config.
   * Falls back to default mappings if widget not found.
   */
  private async loadFieldMappings(
    widgetId?: string,
  ): Promise<Array<{ key: string; contactField?: string }>> {
    if (!widgetId) {
      return this.getDefaultFieldMappings();
    }

    try {
      const widget = await this.widgetService.getCachedWidget(widgetId);
      const fields = widget?.preChatForm?.fields;
      if (fields && fields.length > 0) {
        return fields;
      }
    } catch {
      this.logger.debug(
        `Widget ${widgetId} not found — using default mappings`,
      );
    }

    return this.getDefaultFieldMappings();
  }

  /**
   * Default field mappings when widget config is unavailable.
   * Maps the 3 standard fields: name→firstName, email→emails, phone→phones.
   */
  private getDefaultFieldMappings(): Array<{
    key: string;
    contactField: string;
  }> {
    return [
      { key: 'name', contactField: 'firstName' },
      { key: 'email', contactField: 'emails' },
      { key: 'phone', contactField: 'phones' },
    ];
  }

  /**
   * Build a Contact update object from form data + field mapping rules.
   *
   * Handles:
   * - String fields: direct assignment (firstName, companyName, etc.)
   * - Array fields: addToSet semantics (emails, phones)
   * - Custom fields: nested under customFields.{key}
   * - No contactField: skip (metadata only)
   */
  private buildContactUpdate(
    identityData: Record<string, any>,
    fieldMappings: Array<{ key: string; contactField?: string }>,
  ): {
    contactUpdate: Record<string, any>;
    email?: string;
    phone?: string;
    displayName?: string;
  } {
    const contactUpdate: Record<string, any> = {};
    const customFieldsUpdate: Record<string, any> = {};
    let email: string | undefined;
    let phone: string | undefined;
    let displayName: string | undefined;
    const nameParts: string[] = [];

    for (const fieldDef of fieldMappings) {
      const value = identityData[fieldDef.key];
      if (value === undefined || value === null || value === '') continue;

      const target = fieldDef.contactField;

      // Detect email/phone/name by contactField TARGET (dynamic mapping)
      // not by key name (admin-configured, could be anything).
      if (target === 'emails') email = String(value).toLowerCase();
      if (target === 'phones') phone = String(value);
      if (target === 'firstName' || target === 'lastName') {
        nameParts.push(String(value));
      }

      if (!target) continue; // No mapping → metadata only

      if (target.startsWith('customFields.')) {
        // Custom field: customFields.order_id → { order_id: value }
        const cfKey = target.replace('customFields.', '');
        customFieldsUpdate[cfKey] = value;
      } else if (target === 'emails') {
        contactUpdate.emails = [String(value).toLowerCase()];
      } else if (target === 'phones') {
        contactUpdate.phones = [String(value)];
      } else if (target === 'firstName' && !contactUpdate.firstName) {
        // If mapping to firstName and value looks like full name, split it
        const parts = this.splitName(String(value));
        contactUpdate.firstName = parts.firstName;
        if (parts.lastName) contactUpdate.lastName = parts.lastName;
      } else {
        contactUpdate[target] = value;
      }
    }

    // Build display name from mapped name parts (firstName + lastName)
    if (nameParts.length > 0) {
      displayName = nameParts.join(' ');
    }

    // Fallback: extract email/phone from identityData even without mapping
    // (for backward compatibility with forms that have standard keys)
    if (!email && identityData.email) email = String(identityData.email);
    if (!phone && identityData.phone) phone = String(identityData.phone);
    if (!displayName && identityData.name)
      displayName = String(identityData.name);

    if (Object.keys(customFieldsUpdate).length > 0) {
      contactUpdate.customFields = customFieldsUpdate;
    }

    return { contactUpdate, email, phone, displayName };
  }

  /**
   * Enrich an existing Contact with new data from pre-chat form.
   * Uses addToSet semantics for array fields (emails, phones).
   */
  private async enrichExistingContact(
    contactId: string,
    contactUpdate: Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    email?: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    phone?: string,
  ): Promise<void> {
    const existing = await this.contactsService.findOne(contactId);
    if (!existing) return;

    // Merge array fields with existing values (addToSet)
    if (contactUpdate.emails) {
      contactUpdate.emails = [
        ...new Set([...(existing.emails ?? []), ...contactUpdate.emails]),
      ];
    }
    if (contactUpdate.phones) {
      contactUpdate.phones = [
        ...new Set([...(existing.phones ?? []), ...contactUpdate.phones]),
      ];
    }

    // Merge custom fields
    if (contactUpdate.customFields && existing.customFields) {
      contactUpdate.customFields = {
        ...existing.customFields,
        ...contactUpdate.customFields,
      };
    }

    // Only update if firstName is still 'Visitor' or shadow
    if (existing.isShadow && contactUpdate.firstName) {
      // Shadow contact promotion — will be handled by ContactsService.update()
    } else if (
      existing.firstName === 'Visitor' &&
      contactUpdate.firstName &&
      contactUpdate.firstName !== 'Visitor'
    ) {
      // Replace default 'Visitor' name
    } else {
      // Don't overwrite existing real name
      delete contactUpdate.firstName;
      delete contactUpdate.lastName;
    }

    if (Object.keys(contactUpdate).length > 0) {
      await this.contactsService.update(contactId, contactUpdate);
    }
  }

  /**
   * Find an existing Contact by email/phone dedup, or create a new one.
   * Returns the Contact ID.
   */
  private async findOrCreateContact(
    tenantId: string,
    visitorId: string,
    contactUpdate: Record<string, any>,
    email?: string,
    phone?: string,
    displayName?: string,
  ): Promise<string | null> {
    // Try dedup by email first
    if (email) {
      const byEmail = await this.contactsService.findByEmail(tenantId, email);
      if (byEmail) {
        // Merge visitor identity into existing contact
        try {
          await this.contactsService.mergeIdentity(byEmail.id, {
            channelType: 'livechat',
            senderId: visitorId,
          });
        } catch {
          // Identity may already exist — safe to ignore
        }

        // Update with form data
        await this.enrichExistingContact(
          byEmail.id,
          contactUpdate,
          email,
          phone,
        );
        this.logger.log(
          `Merged visitor ${visitorId} into Contact ${byEmail.id} by email ${email}`,
        );
        return byEmail.id;
      }
    }

    // Try dedup by senderId (livechat identity)
    const bySender = await this.contactsService.findBySenderId(
      tenantId,
      'livechat',
      visitorId,
    );
    if (bySender) {
      await this.enrichExistingContact(
        bySender.id,
        contactUpdate,
        email,
        phone,
      );
      this.logger.log(
        `Enriched existing Contact ${bySender.id} for visitor ${visitorId}`,
      );
      return bySender.id;
    }

    // No match → create new Contact
    const nameParts = this.splitName(displayName || 'Visitor');
    try {
      const newContact = await this.contactsService.create({
        ...nameParts,
        emails: email ? [email.toLowerCase()] : [],
        phones: phone ? [phone] : [],
        ...(contactUpdate.companyName
          ? { companyName: contactUpdate.companyName }
          : {}),
        ...(contactUpdate.title ? { title: contactUpdate.title } : {}),
        ...(contactUpdate.role ? { role: contactUpdate.role } : {}),
        ...(contactUpdate.address ? { address: contactUpdate.address } : {}),
        ...(contactUpdate.customFields
          ? { customFields: contactUpdate.customFields }
          : {}),
        isShadow: !email && !phone,
        omniIdentities: [{ channelType: 'livechat', senderId: visitorId }],
      } as any);

      this.logger.log(
        `Created Contact ${newContact.id} from pre-chat form for visitor ${visitorId}`,
      );
      return newContact.id;
    } catch (err: any) {
      this.logger.error(
        `Failed to create Contact for visitor ${visitorId}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Split a full name string into firstName + lastName.
   */
  private splitName(fullName: string): {
    firstName: string;
    lastName?: string;
  } {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) {
      return { firstName: parts[0] };
    }
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
    };
  }
}
