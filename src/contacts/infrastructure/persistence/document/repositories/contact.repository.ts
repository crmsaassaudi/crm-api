import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types } from 'mongoose';
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

  /**
   * Whitelist of fields allowed in user-submitted filter expressions.
   * Prevents arbitrary field injection into MongoDB queries.
   */
  private readonly ALLOWED_FILTER_FIELDS = new Set([
    'lifecycleStageId',
    'statusId',
    'sourceId',
    'owner',
    'createdBy',
    'updatedBy',
    'companyName',
    'title',
    'role',
    'isVIP',
    'isShadow',
    'tags',
    'emails',
    'phones',
  ]);

  /**
   * Escape special regex metacharacters in user input to prevent ReDoS.
   */
  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private static readonly OWNER_FIELD_MAP: Record<string, string> = {
    owner: 'ownerId',
    createdBy: 'createdById',
    updatedBy: 'updatedById',
  };

  /**
   * Resolve a single filter entry into a [dbField, condition] tuple.
   * Returns null when the filter should be skipped.
   */
  private resolveSingleFilterCondition(f: {
    id: string;
    value: any;
  }): [string, any] | null {
    if (!f.id || !f.value) return null;
    if (!this.ALLOWED_FILTER_FIELDS.has(f.id)) return null;

    if (['emails', 'phones'].includes(f.id)) {
      return [
        f.id,
        { $regex: `^${this.escapeRegex(String(f.value))}$`, $options: 'i' },
      ];
    }

    if (['lifecycleStageId', 'statusId', 'sourceId'].includes(f.id)) {
      return [f.id, Array.isArray(f.value) ? { $in: f.value } : f.value];
    }

    const ownerDbField = ContactRepository.OWNER_FIELD_MAP[f.id];
    if (ownerDbField) {
      return [
        ownerDbField,
        Array.isArray(f.value) ? { $in: f.value } : f.value,
      ];
    }

    if (Array.isArray(f.value)) {
      return [f.id, { $in: f.value }];
    }

    return [f.id, { $regex: this.escapeRegex(String(f.value)), $options: 'i' }];
  }

  private applyParsedFilters(
    where: FilterQuery<ContactSchemaClass>,
    parsedFilters: any[],
  ): void {
    for (const f of parsedFilters) {
      const resolved = this.resolveSingleFilterCondition(f);
      if (resolved) {
        const [dbField, condition] = resolved;
        where[dbField] = condition;
      }
    }
  }

  private applyOwnerRestriction(
    where: FilterQuery<ContactSchemaClass>,
    filterOptions: any,
  ): void {
    const currentUserId = filterOptions.__currentUserId;
    if (currentUserId) {
      where.ownerId = currentUserId;
    }
  }

  private applySearchFilter(
    where: FilterQuery<ContactSchemaClass>,
    search: string,
  ): void {
    const searchTerm = search.trim();
    if (searchTerm.includes('@')) {
      const escaped = this.escapeRegex(searchTerm);
      where.$or = [
        { emails: { $regex: escaped, $options: 'i' } },
        { $text: { $search: searchTerm } },
      ];
    } else {
      where.$text = { $search: searchTerm };
    }
  }

  private buildListWhere(filterOptions?: any) {
    const where: FilterQuery<ContactSchemaClass> = {
      deletedAt: { $exists: false },
    };

    if (filterOptions?.__restrictToOwner) {
      this.applyOwnerRestriction(where, filterOptions);
    }

    if (filterOptions?.search) {
      this.applySearchFilter(where, filterOptions.search);
    }

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
          this.applyParsedFilters(where, parsedFilters);
        }
      } catch (err) {
        const logger = new Logger(ContactRepository.name);
        logger.warn(
          `Malformed filter JSON ignored: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return where;
  }

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Contact>> {
    const where = this.buildListWhere(filterOptions);
    const scopedWhere = this.applyTenantFilter(where);

    const [docs, countResult] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('owner')
        .populate('createdBy')
        .populate('updatedBy')
        .lean()
        .exec(),
      this.countDocumentsWithCap(scopedWhere, 10_000),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc as any)),
      countResult.totalItems,
      paginationOptions,
    );
  }

  async findManyWithCursorPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
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
    const count = await this.model
      .countDocuments(where)
      .limit(countLimit + 1)
      .exec();
    const isExactCount = count <= countLimit;

    return {
      totalItems: isExactCount ? count : countLimit,
      isExactCount,
    };
  }

  /**
   * Build a scoped filter for export operations.
   * Shared by findForExport, streamForExport, and countForExport (DUP-04).
   */
  private buildExportFilter(params: {
    ids?: string[];
    filters?: any;
  }): FilterQuery<ContactSchemaClass> {
    const where =
      params.ids && params.ids.length > 0
        ? ({
            _id: {
              $in: params.ids
                .filter((id) => Types.ObjectId.isValid(id))
                .map((id) => new Types.ObjectId(id)),
            },
            deletedAt: { $exists: false },
          } as FilterQuery<ContactSchemaClass>)
        : this.buildListWhere(params.filters);
    return this.applyTenantFilter(where);
  }

  async findForExport(params: {
    ids?: string[];
    filters?: any;
  }): Promise<ContactSchemaDocument[]> {
    return this.model
      .find(this.buildExportFilter(params))
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Stream contacts for export. Lean + projection + read-preference + batchSize
   * keep memory flat and shift the scan to a secondary so the primary OLTP path
   * (and other tenants) are not impacted.
   */
  streamForExport(
    params: {
      ids?: string[];
      filters?: any;
    },
    opts?: {
      projection?: Record<string, 1>;
      readPreference?: string;
      batchSize?: number;
    },
  ): AsyncIterable<any> & { close(): Promise<void> } {
    const query = this.model
      .find(this.buildExportFilter(params))
      .sort({ createdAt: -1 })
      .lean();
    if (opts?.projection) query.select(opts.projection);
    if (opts?.readPreference) query.read(opts.readPreference as any);
    return query.batchSize(opts?.batchSize ?? 1000).cursor();
  }

  async countForExport(
    params: {
      ids?: string[];
      filters?: any;
    },
    maxTimeMS?: number,
  ): Promise<number> {
    const query = this.model.countDocuments(this.buildExportFilter(params));
    if (maxTimeMS) query.maxTimeMS(maxTimeMS);
    return query.exec();
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
    // LOW-07: Cap results to prevent unbounded scans on large tenants
    const docs = await this.model.find(scopedWhere).limit(50).exec();
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

  async addTagsToContacts(
    contactIds: string[],
    tags: string[],
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const scopedFilter = this.applyTenantFilter({
      _id: { $in: contactIds },
      deletedAt: { $exists: false },
    } as FilterQuery<ContactSchemaClass>);
    const result = await this.model
      .updateMany(scopedFilter, {
        $addToSet: { tags: { $each: tags } },
      })
      .exec();

    return {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
    };
  }

  async updateWithVersionCheck(
    id: string,
    version: number,
    data: Partial<ContactSchemaClass>,
  ): Promise<Contact | null> {
    const scopedFilter = this.applyTenantFilter({ _id: id, __v: version });
    const updatedById = this.cls.get('userId') ?? this.cls.get('user.id');
    const doc = await this.model
      .findOneAndUpdate(
        scopedFilter,
        {
          $set: {
            ...data,
            ...(updatedById ? { updatedById } : {}),
          },
          $inc: { __v: 1 },
        },
        { new: true },
      )
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  async recomputeScoresForAllTenants(
    limit: number,
  ): Promise<{ scanned: number; updated: number }> {
    const docs = await this.model
      .find({ deletedAt: { $exists: false } })
      .select({
        _id: 1,
        emails: 1,
        phones: 1,
        companyName: 1,
        title: 1,
        ownerId: 1,
        lastActivityAt: 1,
        createdAt: 1,
      })
      .limit(limit)
      .lean()
      .exec();

    if (docs.length === 0) {
      return { scanned: 0, updated: 0 };
    }

    const now = Date.now();
    const operations = docs.map((doc: any) => {
      const lastActivityAt = doc.lastActivityAt || doc.createdAt;
      const ageDays = lastActivityAt
        ? Math.max(
            0,
            Math.floor((now - new Date(lastActivityAt).getTime()) / 86_400_000),
          )
        : 365;
      const recencyScore = Math.max(0, 40 - Math.min(40, ageDays));
      const completenessScore =
        (doc.emails?.length ? 15 : 0) +
        (doc.phones?.length ? 15 : 0) +
        (doc.ownerId ? 10 : 0) +
        (doc.companyName ? 10 : 0) +
        (doc.title ? 10 : 0);
      const score = Math.min(100, Math.round(recencyScore + completenessScore));

      return {
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { score } },
        },
      };
    });

    const result = await this.model.bulkWrite(operations, { ordered: false });
    return {
      scanned: docs.length,
      updated: result.modifiedCount,
    };
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
    return history
      .map((entry: any) => ({
        id: entry._id?.toString?.() ?? String(entry._id),
        fromStage: entry.fromStage ?? null,
        toStage: entry.toStage,
        changedAt: entry.changedAt,
        changedById:
          entry.changedById?.toString?.() ?? String(entry.changedById),
        reason: entry.reason,
        direction: entry.direction,
        skippedStages: entry.skippedStages ?? [],
      }))
      .sort(
        (a: any, b: any) =>
          new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime(),
      );
  }
}
