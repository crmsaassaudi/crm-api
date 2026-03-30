import { Injectable, NotFoundException } from '@nestjs/common';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import { Contact } from './domain/contact';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { AccountsService } from '../accounts/accounts.service';
import { DealsService } from '../deals/deals.service';

@Injectable()
export class ContactsService {
  constructor(
    private readonly repository: ContactRepository,
    private readonly accountsService: AccountsService,
    private readonly dealsService: DealsService,
  ) {}

  async create(data: CreateContactDto): Promise<Contact> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const emails = data.emails ?? [];
    const phones = data.phones ?? [];

    // tenant, createdBy, updatedBy are auto-injected by BaseDocumentRepository from CLS
    return this.repository.create({
      ...data,
      emails,
      phones,
      ownerId,
    } as any);
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

    // ── Phase 5.4: Lead Promotion (Shadow Contact) ──
    const existingContact = await this.repository.findOne({ _id: id });
    let additionalData: any = {};
    if (existingContact && existingContact.isShadow) {
      const hasNewEmail = emails && emails.length > 0;
      const hasNewPhone = phones && phones.length > 0;
      if (hasNewEmail || hasNewPhone) {
        additionalData = {
          isShadow: false,
          lifecycleStage: 'marketing_qualified_lead', // Promoted from 'lead'
        };
      }
    }

    // updatedBy is auto-injected by BaseDocumentRepository from CLS
    return this.repository.update(id, {
      ...data,
      ...additionalData,
      ...(emails !== undefined ? { emails } : {}),
      ...(phones !== undefined ? { phones } : {}),
      ownerId,
    } as any);
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
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
        type: d.isConverted ? 'Contact' : 'Lead',
      })),
    };
  }

  async convertLead(
    id: string,
    params: {
      createAccount: boolean;
      accountId?: string;
      accountData?: any;
      dealData?: any;
      isIndividual?: boolean;
    },
  ): Promise<any> {
    const lead = await this.repository.findOne({ _id: id });
    if (!lead) throw new NotFoundException('Lead not found');

    let finalAccountId = params.accountId;

    // 1. Create account if requested
    if (params.createAccount && params.accountData) {
      const account = await this.accountsService.create(params.accountData);
      finalAccountId = account.id;
    }

    // 2. Mark as converted and link to account
    const updatedLead = await this.repository.update(id, {
      isConverted: true,
      status: 'converted',
      accountId: finalAccountId,
    } as any);

    // 3. Create deal if requested
    if (params.dealData && updatedLead) {
      await this.dealsService.create({
        ...params.dealData,
        contactId: updatedLead.id,
        accountId: finalAccountId,
      });
    }

    return {
      success: true,
      contact: id,
      account: finalAccountId,
    };
  }
}
