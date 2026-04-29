import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import { Contact } from './domain/contact';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { AccountsService } from '../accounts/accounts.service';
import { DealsService } from '../deals/deals.service';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AutomationEventPayload,
  buildAutomationEventName,
} from '../automation-rules/events/automation-event.payload';

@Injectable()
export class ContactsService {
  constructor(
    private readonly repository: ContactRepository,
    private readonly accountsService: AccountsService,
    private readonly dealsService: DealsService,
    private readonly settingsService: CrmSettingsService,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(data: CreateContactDto): Promise<Contact> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const emails = data.emails ?? [];
    const phones = data.phones ?? [];

    // tenant, createdBy, updatedBy are auto-injected by BaseDocumentRepository from CLS
    const contact = await this.repository.create({
      ...data,
      emails,
      phones,
      ownerId,
    } as any);

    // Emit automation event: record_created.Contact
    this.emitAutomationEvent('record_created', contact);

    return contact;
  }

  async findAll(filter: any): Promise<any> {
    return this.repository.findManyWithPagination({
      filterOptions: filter,
      paginationOptions: {
        page: Number(filter.page) || 1,
        limit: Number(filter.limit) || 10,
      },
    });
  }

  async findOne(id: string): Promise<Contact | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: UpdateContactDto): Promise<Contact | null> {
    // Sanitize ownerId: empty string is not a valid ObjectId
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const emails = data.emails;
    const phones = data.phones;

    // Shadow contact promotion: when a shadow contact gets real data, promote it
    const existingContact = await this.repository.findOne({ _id: id });
    let additionalData: any = {};
    if (existingContact && existingContact.isShadow) {
      const hasNewEmail = emails && emails.length > 0;
      const hasNewPhone = phones && phones.length > 0;
      if (hasNewEmail || hasNewPhone) {
        additionalData = { isShadow: false };
      }
    }

    // updatedBy is auto-injected by BaseDocumentRepository from CLS
    const updated = await this.repository.update(id, {
      ...data,
      ...additionalData,
      ...(emails !== undefined ? { emails } : {}),
      ...(phones !== undefined ? { phones } : {}),
      ownerId,
    } as any);

    // Emit automation event: field_updated.Contact
    if (updated) {
      const changedFields = Object.keys(data).filter((k) => k !== 'updatedBy');
      this.emitAutomationEvent('field_updated', updated, changedFields);
    }

    return updated;
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }

  /**
   * Merge a new omni-channel identity (e.g. Zalo account) into an existing Contact.
   * Agent workflow: find a contact by phone/email, then link a new channel account.
   */
  async mergeIdentity(
    contactId: string,
    identity: { channelType: string; senderId: string },
  ): Promise<Contact> {
    const contact = await this.repository.findOne({ _id: contactId });
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} not found`);
    }

    // Check if this identity is already linked to another contact
    const existing = await this.repository.findByOmniIdentity(
      identity.channelType,
      identity.senderId,
    );
    if (existing && existing.id !== contactId) {
      throw new BadRequestException(
        `Identity ${identity.channelType}:${identity.senderId} is already linked to contact ${existing.id}`,
      );
    }

    const updated = await this.repository.addOmniIdentity(contactId, identity);
    if (!updated) {
      throw new NotFoundException(
        `Contact ${contactId} not found after update`,
      );
    }
    return updated;
  }

  async checkDuplicate(params: {
    emails?: string;
    phones?: string;
    excludeId?: string;
  }): Promise<any> {
    const duplicates = await this.repository.checkDuplicate(params);
    return {
      isDuplicate: duplicates.length > 0,
      duplicates: duplicates.map((d) => ({
        id: d.id,
        name: `${d.firstName} ${d.lastName}`,
        email: d.emails?.[0],
        phone: d.phones?.[0],
        stage: d.lifecycleStageId,
      })),
    };
  }

  /**
   * Resolve the valid lifecycle stages from tenant settings.
   * Returns an ordered array of stage apiNames.
   */
  private async getValidStages(): Promise<string[]> {
    const lifecycle =
      await this.settingsService.getSetting('lifecycle:Contact');
    if (!lifecycle?.stages || !Array.isArray(lifecycle.stages)) {
      // Fallback: default stage pipeline if no settings configured
      return [
        'subscriber',
        'lead',
        'mql',
        'sql',
        'opportunity',
        'customer',
        'evangelist',
      ];
    }
    return lifecycle.stages
      .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
      .map((s: any) => s.apiName);
  }

  /**
   * Change the lifecycle stage of a contact.
   * This replaces the old convertLead method — "conversion" is now just a stage transition.
   * Records a stage history entry for conversion rate and velocity tracking.
   *
   * Guardrails (v2.5):
   * - Validates that newStage exists in lifecycle config (rejects invalid strings)
   * - Computes transition direction (forward/backward/lateral) for analytics
   * - Records skipped stages when jumping non-sequentially
   */
  async changeStage(
    id: string,
    newStage: string,
    params?: {
      createAccount?: boolean;
      accountId?: string;
      accountData?: any;
      dealData?: any;
      reason?: string;
    },
  ): Promise<any> {
    const contact = await this.repository.findOne({ _id: id });
    if (!contact) throw new NotFoundException('Contact not found');

    // --- Guardrail 1: Validate stage exists in lifecycle config ---
    const validStages = await this.getValidStages();
    if (!validStages.includes(newStage)) {
      throw new BadRequestException(
        `Invalid lifecycle stage: "${newStage}". Valid stages: ${validStages.join(', ')}`,
      );
    }

    const previousStage = contact.lifecycleStageId;

    // --- Guardrail 2: Compute transition direction + skipped stages ---
    const fromIndex = validStages.indexOf(previousStage);
    const toIndex = validStages.indexOf(newStage);

    let direction: 'forward' | 'backward' | 'lateral' = 'lateral';
    let skippedStages: string[] = [];

    if (fromIndex >= 0 && toIndex >= 0) {
      if (toIndex > fromIndex) {
        direction = 'forward';
        // Record any skipped stages (non-sequential forward jump)
        if (toIndex - fromIndex > 1) {
          skippedStages = validStages.slice(fromIndex + 1, toIndex);
        }
      } else if (toIndex < fromIndex) {
        direction = 'backward';
        // Record stages being "reversed over"
        if (fromIndex - toIndex > 1) {
          skippedStages = validStages.slice(toIndex + 1, fromIndex);
        }
      }
    }

    // Get the current user from CLS context for attribution
    const changedById = this.cls.get('user.id') || contact.updatedById;

    // 1. Push stage history entry (atomic $push, no race conditions)
    await this.repository.pushStageHistory(id, {
      fromStage: previousStage,
      toStage: newStage,
      changedAt: new Date(),
      changedById,
      reason: params?.reason,
      direction,
      skippedStages: skippedStages.length > 0 ? skippedStages : undefined,
    });

    let finalAccountId = params?.accountId;

    // 2. Optionally create account on stage transition
    if (params?.createAccount && params?.accountData) {
      const account = await this.accountsService.create(params.accountData);
      finalAccountId = account.id;
    }

    // 3. Update stage (and optionally link to account)
    const updated = await this.repository.update(id, {
      lifecycleStageId: newStage,
      ...(finalAccountId ? { accountId: finalAccountId } : {}),
    } as any);

    // 4. Optionally create deal on stage transition
    let dealId: string | undefined;
    if (params?.dealData && updated) {
      const deal = await this.dealsService.create({
        ...params.dealData,
        contactId: updated.id,
        accountId: finalAccountId,
      });
      dealId = deal.id;
    }

    return {
      success: true,
      contact: id,
      previousStage,
      stage: newStage,
      direction,
      skippedStages: skippedStages.length > 0 ? skippedStages : undefined,
      account: finalAccountId,
      deal: dealId,
    };
  }

  /**
   * Get the stage transition history for a contact.
   * Returns entries sorted newest-first.
   */
  async getStageHistory(id: string): Promise<any[]> {
    const contact = await this.repository.findOne({ _id: id });
    if (!contact) throw new NotFoundException('Contact not found');
    return this.repository.getStageHistory(id);
  }

  // ── Automation Event Emitter ─────────────────────────────────────────────

  private emitAutomationEvent(
    event: 'record_created' | 'field_updated',
    record: Contact,
    changedFields?: string[],
  ): void {
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    if (!tenantId) return; // No tenant context (e.g. seeder, migration)

    const payload: AutomationEventPayload = {
      tenantId,
      event,
      object: 'Contact',
      recordId: record.id,
      data: record as any,
      ...(changedFields ? { changedFields } : {}),
      automationDepth: 0,
    };

    // Fire-and-forget — errors are caught by the listener
    this.eventEmitter.emit(buildAutomationEventName(event, 'Contact'), payload);
  }
}
