import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import {
  ContactSchemaClass,
  ContactSchemaDocument,
} from '../entities/contact.schema';
import { Contact } from '../../../../domain/contact';
import { ContactMapper } from '../mappers/contact.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';

@Injectable()
export class ContactRepository extends BaseDocumentRepository<
  ContactSchemaDocument,
  Contact
> {
  constructor(
    @InjectModel(ContactSchemaClass.name)
    contactModel: Model<ContactSchemaDocument>,
    cls: ClsService,
  ) {
    super(contactModel, cls);
  }

  protected mapToDomain(doc: ContactSchemaClass): Contact {
    return ContactMapper.toDomain(doc);
  }

  protected toPersistence(domain: Contact): ContactSchemaClass {
    return ContactMapper.toPersistence(domain);
  }

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any | null;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Contact>> {
    const where: FilterQuery<ContactSchemaClass> = {};

    if (filterOptions?.search) {
      const searchExpr = { $regex: filterOptions.search, $options: 'i' };
      where.$or = [
        { firstName: searchExpr },
        { lastName: searchExpr },
        { emails: searchExpr },
        { companyName: searchExpr },
      ];
    }

    // Filter by lifecycle stage (replaces the old isConverted filter)
    if (filterOptions?.lifecycleStage) {
      where.lifecycleStage = filterOptions.lifecycleStage;
    }

    if (filterOptions?.filters) {
      try {
        const parsedFilters =
          typeof filterOptions.filters === 'string'
            ? JSON.parse(filterOptions.filters)
            : filterOptions.filters;
        if (Array.isArray(parsedFilters)) {
          parsedFilters.forEach((f: any) => {
            if (f.id && f.value) {
              if (['lifecycleStage', 'status', 'source'].includes(f.id)) {
                where[f.id] = f.value;
              } else {
                where[f.id] = { $regex: f.value, $options: 'i' };
              }
            }
          });
        }
      } catch {
        // ignore parse errors
      }
    }

    const scopedWhere = this.applyTenantFilter(where);

    const [docs, totalItems] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('owner')
        .populate('createdBy')
        .populate('updatedBy')
        .exec(),
      this.model.countDocuments(scopedWhere).exec(),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc)),
      totalItems,
      paginationOptions,
    );
  }

  async findOne(
    filter: FilterQuery<ContactSchemaClass>,
  ): Promise<Contact | null> {
    const scopedFilter = this.applyTenantFilter(filter);
    const doc = await this.model
      .findOne(scopedFilter)
      .populate('owner')
      .populate('createdBy')
      .populate('updatedBy')
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  async checkDuplicate(params: {
    emails?: string;
    phones?: string;
    excludeId?: string;
  }): Promise<Contact[]> {
    const { emails, phones, excludeId } = params;
    const where: FilterQuery<ContactSchemaClass> = {};

    const conditions: FilterQuery<ContactSchemaClass>[] = [];
    if (emails) conditions.push({ emails: { $in: [emails] } });
    if (phones) conditions.push({ phones: { $in: [phones] } });

    if (conditions.length === 0) return [];

    where.$or = conditions;
    if (excludeId) {
      where._id = { $ne: excludeId };
    }

    const scopedWhere = this.applyTenantFilter(where);
    const docs = await this.model.find(scopedWhere).exec();
    return docs.map((doc) => this.mapToDomain(doc));
  }

  /**
   * Find a contact by an omni-channel identity (channelType + senderId).
   */
  async findByOmniIdentity(
    channelType: string,
    senderId: string,
  ): Promise<Contact | null> {
    const where: FilterQuery<ContactSchemaClass> = {
      omniIdentities: {
        $elemMatch: { channelType, senderId },
      },
    };
    const scopedWhere = this.applyTenantFilter(where);
    const doc = await this.model.findOne(scopedWhere).exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  /**
   * Atomically push a new omni identity into the contact's array.
   * Uses $addToSet to prevent duplicates.
   */
  async addOmniIdentity(
    contactId: string,
    identity: { channelType: string; senderId: string },
  ): Promise<Contact | null> {
    const scopedFilter = this.applyTenantFilter({ _id: contactId });
    const doc = await this.model
      .findOneAndUpdate(
        scopedFilter,
        {
          $addToSet: { omniIdentities: identity },
        },
        { new: true },
      )
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  /**
   * Fast lean query to check if a sender is a VIP customer.
   * Uses the `tenant_sender_vip_lookup` compound index for speed.
   * Does NOT load the full contact document.
   */
  async isVIPSender(tenantId: string, senderId: string): Promise<boolean> {
    const doc = await this.model
      .findOne(
        {
          tenantId,
          'omniIdentities.senderId': senderId,
          isVIP: true,
        },
        { _id: 1 },
      )
      .lean()
      .exec();
    return !!doc;
  }
}
