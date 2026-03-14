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

    if (filterOptions?.isConverted !== undefined) {
      where.isConverted = filterOptions.isConverted;
    }

    if (filterOptions?.filters) {
      try {
        const parsedFilters = typeof filterOptions.filters === 'string' 
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
      } catch (e) {
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
    const doc = await this.model.findOne(scopedFilter).populate('owner').exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  async checkDuplicate(params: {
    email?: string;
    phone?: string;
    excludeId?: string;
  }): Promise<Contact[]> {
    const { email, phone, excludeId } = params;
    const where: FilterQuery<ContactSchemaClass> = {};

    const conditions: FilterQuery<ContactSchemaClass>[] = [];
    if (email) conditions.push({ emails: { $in: [email] } });
    if (phone) conditions.push({ phones: { $in: [phone] } });

    if (conditions.length === 0) return [];

    where.$or = conditions;
    if (excludeId) {
      where._id = { $ne: excludeId };
    }

    const scopedWhere = this.applyTenantFilter(where);
    const docs = await this.model.find(scopedWhere).exec();
    return docs.map((doc) => this.mapToDomain(doc));
  }
}
