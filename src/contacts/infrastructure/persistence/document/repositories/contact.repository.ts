import { BadRequestException, Injectable } from '@nestjs/common';
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
import { ICursorPaginationOptions } from '../../../../../utils/types/cursor-pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { CursorPaginationResponseDto } from '../../../../../utils/dto/cursor-pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';
import {
  buildMongoCursorFilter,
  buildMongoCursorSort,
  cursorPagination,
  decodeCursor,
  encodeCursor,
  normalizeCursorDirection,
  normalizeSortOrder,
} from '../../../../../utils/cursor-pagination';

@Injectable()
export class ContactRepository extends BaseDocumentRepository<
  ContactSchemaDocument,
  Contact
> {
  private readonly cursorSortableFields = new Set([
    'createdAt',
    'updatedAt',
    'lastActivityAt',
    'firstName',
    'lastName',
    'companyName',
    'score',
  ]);

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

  private buildListWhere(filterOptions?: any | null) {
    const where: FilterQuery<ContactSchemaClass> = {
      deletedAt: { $exists: false },
    };

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
      where.lifecycleStageId = filterOptions.lifecycleStage;
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
              if (['lifecycleStageId', 'statusId', 'sourceId'].includes(f.id)) {
                where[f.id] = f.value;
              } else if (['owner', 'createdBy', 'updatedBy'].includes(f.id)) {
                // Map virtual field names to actual DB field names
                const fieldMap: Record<string, string> = {
                  owner: 'ownerId',
                  createdBy: 'createdById',
                  updatedBy: 'updatedById',
                };
                const dbField = fieldMap[f.id] || f.id;
                where[dbField] = Array.isArray(f.value)
                  ? { $in: f.value }
                  : f.value;
              } else if (Array.isArray(f.value)) {
                // Any other array value: use $in
                where[f.id] = { $in: f.value };
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

    return where;
  }

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any | null;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Contact>> {
    const where = this.buildListWhere(filterOptions);
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
        .populate('contactStatus')
        .populate('contactSource')
        .populate('contactLifecycleStage')
        .exec(),
      this.model.countDocuments(scopedWhere).exec(),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc)),
      totalItems,
      paginationOptions,
    );
  }

  async findManyWithCursorPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any | null;
    paginationOptions: ICursorPaginationOptions;
  }): Promise<CursorPaginationResponseDto<Contact>> {
    const where = this.buildListWhere(filterOptions);
    const scopedWhere = this.applyTenantFilter(where);
    const limit = paginationOptions.limit;
    const countLimit = paginationOptions.countLimit ?? 10_000;
    const direction = normalizeCursorDirection(paginationOptions.direction);
    const sortOrder = normalizeSortOrder(paginationOptions.sortOrder);
    const sortField = this.resolveCursorSortField(paginationOptions.sortBy);

    const cursorFilter = paginationOptions.cursor
      ? buildMongoCursorFilter<ContactSchemaClass>({
          sortField,
          sortOrder,
          direction,
          ...this.decodeDocumentCursor(
            paginationOptions.cursor,
            sortField,
            sortOrder,
          ),
        })
      : null;

    const queryWhere = cursorFilter
      ? ({
          $and: [scopedWhere, cursorFilter],
        } as FilterQuery<ContactSchemaClass>)
      : scopedWhere;

    const [docs, cappedCount] = await Promise.all([
      this.model
        .find(queryWhere)
        .sort(buildMongoCursorSort(sortField, sortOrder, direction))
        .limit(limit + 1)
        .populate('owner')
        .populate('createdBy')
        .populate('updatedBy')
        .populate('contactStatus')
        .populate('contactSource')
        .populate('contactLifecycleStage')
        .exec(),
      this.countDocumentsWithCap(scopedWhere, countLimit),
    ]);

    const hasExtraPage = docs.length > limit;
    let pageDocs = hasExtraPage ? docs.slice(0, limit) : docs;

    if (direction === 'prev') {
      pageDocs = pageDocs.reverse();
    }

    const firstDoc = pageDocs[0];
    const lastDoc = pageDocs[pageDocs.length - 1];
    const hasCursor = Boolean(paginationOptions.cursor);

    return cursorPagination(
      pageDocs.map((doc) => this.mapToDomain(doc)),
      {
        nextCursor: lastDoc
          ? this.encodeDocumentCursor(lastDoc, sortField, sortOrder)
          : null,
        prevCursor: firstDoc
          ? this.encodeDocumentCursor(firstDoc, sortField, sortOrder)
          : null,
        hasNextPage: direction === 'prev' ? hasCursor : hasExtraPage,
        hasPreviousPage: direction === 'prev' ? hasExtraPage : hasCursor,
        totalItems: cappedCount.totalItems,
        isExactCount: cappedCount.isExactCount,
      },
    );
  }

  private resolveCursorSortField(sortBy?: string): string {
    return sortBy && this.cursorSortableFields.has(sortBy)
      ? sortBy
      : 'createdAt';
  }

  private decodeDocumentCursor(
    cursor: string,
    sortField: string,
    sortOrder: 'asc' | 'desc',
  ) {
    const decoded = decodeCursor(cursor);

    if (decoded.sortBy && decoded.sortBy !== sortField) {
      throw new BadRequestException(
        'Cursor does not match the requested sort field',
      );
    }

    if (decoded.sortOrder && decoded.sortOrder !== sortOrder) {
      throw new BadRequestException(
        'Cursor does not match the requested sort order',
      );
    }

    return {
      cursorValue: this.coerceCursorValue(sortField, decoded.sortValue),
      cursorId: decoded.id,
    };
  }

  private coerceCursorValue(
    sortField: string,
    value: string | number | boolean | null,
  ): string | number | boolean | Date {
    if (value === null || value === undefined) {
      throw new BadRequestException('Invalid pagination cursor');
    }

    if (['createdAt', 'updatedAt'].includes(sortField)) {
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) {
        throw new BadRequestException('Invalid pagination cursor');
      }

      return date;
    }

    if (sortField === 'score') {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)) {
        throw new BadRequestException('Invalid pagination cursor');
      }

      return numberValue;
    }

    return value;
  }

  private encodeDocumentCursor(
    doc: ContactSchemaDocument,
    sortField: string,
    sortOrder: 'asc' | 'desc',
  ): string {
    const rawSortValue =
      typeof doc.get === 'function'
        ? doc.get(sortField)
        : (doc as any)[sortField];
    const sortValue =
      rawSortValue instanceof Date ? rawSortValue.toISOString() : rawSortValue;

    return encodeCursor({
      sortValue: sortValue ?? null,
      id: String((doc as any)._id),
      sortBy: sortField,
      sortOrder,
    });
  }

  private async countDocumentsWithCap(
    where: FilterQuery<ContactSchemaClass>,
    countLimit: number,
  ): Promise<{ totalItems: number; isExactCount: boolean }> {
    const docs = await this.model
      .find(where)
      .select({ _id: 1 })
      .limit(countLimit + 1)
      .lean()
      .exec();

    const isExactCount = docs.length <= countLimit;

    return {
      totalItems: isExactCount ? docs.length : countLimit,
      isExactCount,
    };
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
      .populate('contactStatus')
      .populate('contactSource')
      .populate('contactLifecycleStage')
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
   * Atomically add an email to a contact's emails[] array if not already present.
   */
  async addEmailIfMissing(contactId: string, email: string): Promise<void> {
    const scopedFilter = this.applyTenantFilter({ _id: contactId });
    await this.model
      .updateOne(scopedFilter, {
        $addToSet: { emails: email },
      })
      .exec();
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

  /**
   * Atomically push a new stage history entry into the contact's stageHistory array.
   * Uses $push to avoid race conditions.
   */
  async pushStageHistory(
    contactId: string,
    entry: {
      fromStage: string | null;
      toStage: string;
      changedAt: Date;
      changedById: string;
      reason?: string;
      direction?: 'forward' | 'backward' | 'lateral';
      skippedStages?: string[];
    },
  ): Promise<void> {
    const scopedFilter = this.applyTenantFilter({ _id: contactId });
    await this.model
      .updateOne(scopedFilter, {
        $push: { stageHistory: entry },
      })
      .exec();
  }

  async touchLastActivity(
    contactId: string,
    occurredAt = new Date(),
  ): Promise<void> {
    const scopedFilter = this.applyTenantFilter({ _id: contactId });
    await this.model
      .updateOne(scopedFilter, {
        $set: { lastActivityAt: occurredAt },
      })
      .exec();
  }

  /**
   * Get the stage history of a contact, sorted by changedAt descending (newest first).
   */
  async getStageHistory(contactId: string): Promise<
    Array<{
      fromStage: string | null;
      toStage: string;
      changedAt: Date;
      changedById: string;
      reason?: string;
      direction?: 'forward' | 'backward' | 'lateral';
      skippedStages?: string[];
    }>
  > {
    const scopedFilter = this.applyTenantFilter({ _id: contactId });
    const doc = await this.model
      .findOne(scopedFilter, { stageHistory: 1 })
      .lean()
      .exec();
    if (!doc) return [];
    const history = (doc.stageHistory || []) as any[];
    return history.sort(
      (a: any, b: any) =>
        new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime(),
    );
  }
}
