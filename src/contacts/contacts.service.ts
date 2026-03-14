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
    // Sanitize owner: empty string is not a valid ObjectId
    const owner = data.owner === '' ? undefined : data.owner;
    const emails = data.emails ?? [];
    const phones = data.phones ?? [];

    // tenant, createdBy, updatedBy are auto-injected by BaseDocumentRepository from CLS
    return this.repository.create({
      ...data,
      emails,
      phones,
      owner,
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
    // Sanitize owner: empty string is not a valid ObjectId
    const owner = data.owner === '' ? undefined : data.owner;
    const emails = data.emails;
    const phones = data.phones;

    // updatedBy is auto-injected by BaseDocumentRepository from CLS
    return this.repository.update(id, {
      ...data,
      ...(emails !== undefined ? { emails } : {}),
      ...(phones !== undefined ? { phones } : {}),
      owner,
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
      account: finalAccountId,
    } as any);

    // 3. Create deal if requested
    if (params.dealData && updatedLead) {
      await this.dealsService.create({
        ...params.dealData,
        contact: updatedLead.id,
        account: finalAccountId,
      });
    }

    return {
      success: true,
      contact: id,
      account: finalAccountId,
    };
  }
}
