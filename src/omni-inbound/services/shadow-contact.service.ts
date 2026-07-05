import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OmniPayload } from '../domain/omni-payload';
import { OmniEvents } from '../domain/omni-events';
import { ContactsService } from '../../contacts/contacts.service';
import { TenantsService } from '../../tenants/tenants.service';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';

/**
 * ShadowContactService — handles automated contact creation and identity
 * resolution for inbound omni-channel messages.
 *
 * Extracted from ConversationService (T-001) to isolate the shadow contact
 * lifecycle from the message processing pipeline.
 *
 * Responsibilities:
 *   1. Create shadow contacts from inbound message metadata
 *   2. Email-specific deduplication (by email and senderId)
 *   3. Auto-merge logic (phone/email match against existing contacts)
 *   4. Identity resolution configuration
 */
@Injectable()
export class ShadowContactService {
  private readonly logger = new Logger(ShadowContactService.name);

  constructor(
    private readonly contactsService: ContactsService,
    private readonly tenantsService: TenantsService,
    private readonly settingsService: CrmSettingsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a shadow contact for a new inbound sender.
   *
   * Steps:
   * 1. Resolve system actor (tenant ownerId)
   * 2. Email-specific deduplication
   * 3. Auto-merge check (phone/email)
   * 4. Create new shadow contact if no match
   */
  async createShadowContact(
    payload: OmniPayload,
    enrichedProfile: { name?: string; avatarUrl?: string; phone?: string } = {},
  ): Promise<string | null> {
    try {
      const systemActorId = await this.resolveSystemActor(payload.tenantId);
      if (!systemActorId) return null;

      const identityConfig = await this.getIdentityResolutionConfig(
        payload.tenantId,
      );

      // Email-specific deduplication
      if (payload.channelType === 'email' && payload.senderId) {
        const emailMatchId = await this.resolveEmailContact(payload);
        if (emailMatchId) return emailMatchId;
      }

      // Auto-merge check
      if (identityConfig.autoMergeShadowContact) {
        const mergedId = await this.tryAutoMerge(payload);
        if (mergedId) return mergedId;
      }

      // Create shadow contact
      return this.persistShadowContact(payload, enrichedProfile, systemActorId);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `Failed to create Shadow Contact for sender ${payload.senderId}: ${error.message}`,
        error.stack ?? JSON.stringify(err),
      );
      return null;
    }
  }

  /**
   * Resolve the system actor (tenant owner) for shadow contact creation.
   * Returns null if the tenant has no owner.
   */
  private async resolveSystemActor(tenantId: string): Promise<string | null> {
    const tenant = await this.tenantsService.findById(tenantId);
    const systemActorId = tenant?.ownerId ?? null;
    if (!systemActorId) {
      this.logger.warn(
        `Skipping shadow contact creation: tenant ${tenantId} has no ownerId`,
      );
    }
    return systemActorId;
  }

  /**
   * Email-specific deduplication: try to match by email address,
   * then by senderId identity. Returns existing contact ID or null.
   */
  private async resolveEmailContact(
    payload: OmniPayload,
  ): Promise<string | null> {
    const senderEmail = payload.senderId.toLowerCase();

    const existingByEmail = await this.contactsService.findByEmail(
      payload.tenantId,
      senderEmail,
    );
    if (existingByEmail) {
      try {
        await this.contactsService.mergeIdentity(existingByEmail.id, {
          channelType: this.toSchemaChannelType(payload.channelType),
          senderId: payload.senderId,
        });
      } catch {
        /* identity may already exist */
      }
      this.logger.log(
        `Reused existing contact ${existingByEmail.id} for email ${senderEmail}`,
      );
      return existingByEmail.id;
    }

    const existingByIdentity = await this.contactsService.findBySenderId(
      payload.tenantId,
      this.toSchemaChannelType(payload.channelType),
      payload.senderId,
    );
    if (existingByIdentity) {
      try {
        await this.contactsService.addEmailIfMissing(
          existingByIdentity.id,
          senderEmail,
        );
      } catch {
        /* best effort */
      }
      this.logger.log(
        `Reused existing contact ${existingByIdentity.id} for sender ${senderEmail} (identity match)`,
      );
      return existingByIdentity.id;
    }

    return null;
  }

  /**
   * Auto-merge: check if the sender matches an existing contact
   * by phone or email. Returns merged contact ID or null.
   */
  private async tryAutoMerge(payload: OmniPayload): Promise<string | null> {
    const phone = payload.metadata?.phone;
    const email =
      payload.metadata?.email ??
      (payload.channelType === 'email' ? payload.senderId : undefined);

    if (!phone && !email) return null;

    const duplicateResult = await this.contactsService.checkDuplicate({
      phones: phone,
      emails: email,
    });

    if (
      !duplicateResult.isDuplicate ||
      duplicateResult.duplicates.length === 0
    ) {
      return null;
    }

    const existingContact = duplicateResult.duplicates[0];
    try {
      await this.contactsService.mergeIdentity(existingContact.id, {
        channelType: this.toSchemaChannelType(payload.channelType),
        senderId: payload.senderId,
      });

      this.logger.log(
        `Auto-merged sender ${payload.senderId} into existing contact ${existingContact.id} ` +
          `(matched by ${phone ? 'phone' : 'email'})`,
      );

      this.eventEmitter.emit(OmniEvents.CONTACT_AUTO_MERGED, {
        tenantId: payload.tenantId,
        existingContactId: existingContact.id,
        senderId: payload.senderId,
        channelType: payload.channelType,
        matchedBy: phone ? 'phone' : 'email',
      });

      return existingContact.id;
    } catch (mergeErr) {
      this.logger.warn(
        `Auto-merge failed for sender ${payload.senderId}: ${(mergeErr as Error).message} — creating shadow instead`,
      );
      return null;
    }
  }

  /**
   * Persist a new shadow contact from the inbound payload.
   */
  private async persistShadowContact(
    payload: OmniPayload,
    enrichedProfile: { name?: string; avatarUrl?: string; phone?: string },
    systemActorId: string,
  ): Promise<string> {
    const displayName =
      enrichedProfile.name ?? payload.metadata?.contactName ?? payload.senderId;

    const nameParts = displayName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName =
      nameParts.length > 1 ? nameParts.slice(1).join(' ') : '(Omni)';

    const emailsArray =
      payload.channelType === 'email' && payload.senderId
        ? [payload.senderId.toLowerCase()]
        : [];

    const contact = await this.contactsService.create({
      tenantId: payload.tenantId,
      firstName,
      lastName,
      emails: emailsArray,
      status: 'new',
      lifecycleStage: 'lead',
      source: this.toSchemaChannelType(payload.channelType),
      omniIdentities: [
        {
          channelType: this.toSchemaChannelType(payload.channelType),
          senderId: payload.senderId,
        },
      ],
      isShadow: true,
      createdById: systemActorId,
      updatedById: systemActorId,
    } as any); // Shadow fields not in CreateContactDto

    this.logger.log(
      `Created Shadow Contact ${contact.id} for sender ${payload.senderId}`,
    );

    return contact.id;
  }

  // ────────────────────────────────────────────────────────────────
  // Configuration
  // ────────────────────────────────────────────────────────────────

  /**
   * Load identity resolution configuration from tenant CRM settings.
   * Controls shadow contact creation, social profile enrichment, and auto-merge behavior.
   */
  async getIdentityResolutionConfig(tenantId?: string): Promise<{
    autoCreateShadowContact: boolean;
    autoEnrichProfile: boolean;
    enrichmentDisclaimer: string;
    autoMergeShadowContact: boolean;
    autoMergeStrategy: string;
  }> {
    const defaults = {
      autoCreateShadowContact: true,
      autoEnrichProfile: true,
      enrichmentDisclaimer:
        'We collect publicly available profile information to improve your customer experience. You may request data deletion at any time.',
      autoMergeShadowContact: true,
      autoMergeStrategy: 'phone_email_match',
    };

    try {
      const config = await this.settingsService.getSetting(
        'omni_identity_resolution',
        tenantId,
      );
      return config ? { ...defaults, ...config } : defaults;
    } catch (err) {
      this.logger.warn(
        `Failed to load omni_identity_resolution settings: ${(err as Error).message}`,
      );
      return defaults;
    }
  }

  /**
   * Look up an existing contact by ID.
   * Used by ConversationService to populate conversation.customer
   * with enriched data when a pre-identified visitor sends their first message.
   */
  async findContact(contactId: string): Promise<{
    firstName?: string;
    lastName?: string;
    emails?: string[];
    phones?: string[];
  } | null> {
    try {
      const contact = await this.contactsService.findOne(contactId);
      if (!contact) return null;
      return {
        firstName: contact.firstName,
        lastName: contact.lastName,
        emails: contact.emails,
        phones: contact.phones,
      };
    } catch {
      return null;
    }
  }

  /**
   * Enrich a profile object with data from a CRM Contact.
   */
  async enrichProfileFromContact(
    contactId: string,
    profile: any,
  ): Promise<any> {
    const contact = await this.findContact(contactId);
    if (!contact) return profile;

    const enriched = { ...profile };
    const fullName = [contact.firstName, contact.lastName]
      .filter(Boolean)
      .join(' ');

    if (fullName && fullName !== 'Visitor') {
      enriched.name = fullName;
    }
    if (!enriched.phone && contact.phones?.[0]) {
      enriched.phone = contact.phones[0];
    }
    if (contact.emails?.[0]) {
      enriched.email = contact.emails[0];
    }

    return enriched;
  }

  // ── Private Helpers ────────────────────────────────────────────

  private toSchemaChannelType(type: string): string {
    return type.toLowerCase();
  }
}
