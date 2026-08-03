import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, FilterQuery, Types } from 'mongoose';
import {
  ContactSchemaClass,
  ContactSchemaDocument,
} from '../entities/contact.schema';
import { Contact } from '../../../../domain/contact';
import { ContactMapper } from '../mappers/contact.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { VisibilityModule } from '../../../../../common/permissions/visibility-modules';
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
import { normalizeEmail } from '../../../../../common/identity/identity-normalizer';
import {
  buildPhoneSearchPrefixes,
  phoneSearchClause,
} from '../../../../search/phone-search';

@Injectable()
export class ContactRepository extends BaseDocumentRepository<
  ContactSchemaDocument,
  Contact
> {
  private readonly cursorSortableFields = new Set([
    'createdAt',
    'updatedAt',
    'firstName',
    'lastName',
    'score',
  ]);

  constructor(
    @InjectModel(ContactSchemaClass.name)
    contactModel: Model<ContactSchemaDocument>,
    cls: ClsService,
  ) {
    super(contactModel, cls);
  }

  /** Tagged so a tenant can scope contacts differently from other modules. */
  protected visibilityModule(): VisibilityModule {
    return 'Contact';
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
   *
   * `customFields.<key>` is accepted in addition to the static whitelist, but
   * only for keys the tenant actually declared in its `custom_fields` registry —
   * passed in as `allowedCustomFieldKeys`. Before this, an admin could define a
   * custom field the product then had no way to filter, sort or report on: the
   * registry let them create it and every query path rejected it. Validating
   * against the registry rather than accepting any dotted path keeps the original
   * purpose of this whitelist (no arbitrary field injection into the query)
   * intact — an undeclared key is still refused.
   */
  private resolveSingleFilterCondition(
    f: {
      id: string;
      value: any;
    },
    allowedCustomFieldKeys?: Set<string>,
  ): [string, any] | null {
    if (!f.id || !f.value) return null;

    if (f.id.startsWith('customFields.')) {
      const key = f.id.slice('customFields.'.length);
      // No registry supplied, or a key that is not in it → refuse, do not guess.
      if (!key || !allowedCustomFieldKeys?.has(key)) return null;
      return [
        `customFields.${key}`,
        Array.isArray(f.value)
          ? { $in: f.value }
          : typeof f.value === 'string'
            ? { $regex: this.escapeRegex(f.value), $options: 'i' }
            : f.value,
      ];
    }

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
    allowedCustomFieldKeys?: Set<string>,
  ): void {
    for (const f of parsedFilters) {
      const resolved = this.resolveSingleFilterCondition(
        f,
        allowedCustomFieldKeys,
      );
      if (resolved) {
        const [dbField, condition] = resolved;
        where[dbField] = condition;
      }
    }
  }

  /**
   * Apply the legacy `data_access_policy.restrict_own_contacts` flag.
   *
   * Written into `$and` rather than onto `where.ownerId` directly. The bare-key
   * form was overwritable: `applyParsedFilters` runs afterwards and maps a
   * client-supplied `{ id: 'owner', value: X }` onto the SAME `ownerId` key, so a
   * user in a restricted tenant could read other people's contacts just by
   * sending a filter. An `$and` clause cannot be overwritten by a later
   * assignment — the two conditions intersect instead, which is what "restrict"
   * has to mean.
   *
   * (The RBAC visibility axes in `applyTenantFilter` were never bypassable this
   * way — they were already `$and`-ed. This flag is the separate, older control a
   * tenant enables on top, and it is the one that failed.)
   */
  private applyOwnerRestriction(
    where: FilterQuery<ContactSchemaClass>,
    filterOptions: any,
  ): void {
    const currentUserId = filterOptions.__currentUserId;
    if (!currentUserId) return;
    where.$and = [...((where.$and as any[]) ?? []), { ownerId: currentUserId }];
  }

  private applySearchFilter(
    where: FilterQuery<ContactSchemaClass>,
    search: string,
    defaultCountryCode?: string,
  ): void {
    const searchTerm = search.trim();
    if (searchTerm.includes('@')) {
      // Full email identities are normalised at every write boundary and have a
      // tenant-prefixed multikey index. Equality can use that index; the former
      // unanchored /i regex could not and turned a common exact lookup into a
      // tenant-wide scan at large cardinality.
      const normalisedEmail = normalizeEmail(searchTerm);
      where.emails = normalisedEmail;
      return;
    }

    // A phone number was previously handed to `$text`, whose index covers
    // firstName, lastName and emails — so it matched nothing, and the single
    // most frequent lookup in a call centre ("the number that is ringing")
    // returned an empty list. The digits never had a chance of being found,
    // even though `tenant_phone_lookup` exists and the search index already
    // knows how to answer this.
    const phonePrefixes = buildPhoneSearchPrefixes(
      searchTerm,
      defaultCountryCode,
    );
    if (phonePrefixes?.length) {
      (where.$and as any[]) = [
        ...((where.$and as any[]) ?? []),
        phoneSearchClause(phonePrefixes),
      ];
      return;
    }

    where.$text = { $search: searchTerm };
  }

  /**
   * True when this list request carries a free-text search.
   *
   * Used to skip the companion count: a `$text` query must use the text index,
   * which cannot also supply the requested sort order, so the count re-executes
   * the whole match — the single most expensive thing a search request does,
   * done twice, for a number the UI renders as "25+" anyway.
   */
  private hasSearchTerm(filterOptions?: any): boolean {
    return typeof filterOptions?.search === 'string'
      ? filterOptions.search.trim().length > 0
      : false;
  }

  private buildListWhere(filterOptions?: any) {
    // `deletedAt: null` matches BOTH a missing field and an explicit null, which
    // `$exists: false` does not. That difference matters now that records come
    // back from the recycle bin and from an unmerge: a restore that writes
    // `deletedAt: null` instead of unsetting the field would leave the contact
    // invisible under an `$exists` filter, i.e. restored but still gone.
    const where: FilterQuery<ContactSchemaClass> = { deletedAt: null };

    if (filterOptions?.__restrictToOwner) {
      this.applyOwnerRestriction(where, filterOptions);
    }

    if (filterOptions?.search) {
      this.applySearchFilter(
        where,
        filterOptions.search,
        filterOptions.__defaultCountryCode,
      );
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
          // Resolved once per request by ContactsService from the tenant's
          // custom_fields registry; absent means custom-field filters are
          // refused rather than passed through.
          this.applyParsedFilters(
            where,
            parsedFilters,
            filterOptions.__allowedCustomFieldKeys,
          );
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
    const searching = this.hasSearchTerm(filterOptions);

    // One row beyond the page, so a search request can report "there is more"
    // without paying for a count it cannot serve cheaply.
    const fetchLimit = searching
      ? paginationOptions.limit + 1
      : paginationOptions.limit;
    const skip = (paginationOptions.page - 1) * paginationOptions.limit;

    const [docs, countResult] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(fetchLimit)
        .populate('owner')
        .populate('createdBy')
        .populate('updatedBy')
        .lean()
        .exec(),
      searching
        ? Promise.resolve(null)
        : this.countDocumentsWithCap(scopedWhere, 10_000),
    ]);

    const hasExtraPage = searching && docs.length > paginationOptions.limit;
    const pageDocs = hasExtraPage
      ? docs.slice(0, paginationOptions.limit)
      : docs;

    // With no count, the honest total is "at least what we have seen". The
    // DataTable renders a non-exact total as "N+", so a lower bound reads
    // correctly instead of claiming a page is the whole result set.
    const totalItems =
      countResult?.totalItems ??
      skip + pageDocs.length + (hasExtraPage ? 1 : 0);

    return pagination(
      pageDocs.map((doc) => this.mapToDomain(doc as any)),
      totalItems,
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

    const searching = this.hasSearchTerm(filterOptions);
    const [docs, cappedCount] = await Promise.all([
      this.model
        .find(queryWhere)
        .sort(buildMongoCursorSort(sortField, sortOrder, direction))
        .limit(limit + 1)
        .populate('owner')
        .populate('createdBy')
        .populate('updatedBy')
        .exec(),
      searching
        ? Promise.resolve(null)
        : this.countDocumentsWithCap(scopedWhere, countLimit),
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
        // A search request reports what it has actually seen and flags the count
        // as inexact, which the table renders as "N+". Claiming an exact total
        // would require running the text search a second time.
        totalItems: cappedCount?.totalItems ?? pageDocs.length,
        isExactCount: cappedCount?.isExactCount ?? !hasExtraPage,
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
            deletedAt: null,
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
    // Exclude soft-deleted records unless the caller asks for one explicitly.
    //
    // This did not matter while `remove()` hard-deleted — the row was gone, so a
    // fetch returned null on its own. Once deletion became a soft delete the
    // unfiltered lookup started serving deleted records: `GET /:id` answered 200
    // instead of 404, the detail page rendered a deleted record as editable, and
    // automation's `fetchRecord` resumed delayed workflows against it — which is how
    // a "wait 3 days then email" step ends up emailing a deleted contact.
    //
    // Passing `deletedAt` explicitly opts out, which is what the merge and restore
    // paths need.
    const scopedFilter = this.applyTenantFilter(
      filter.deletedAt !== undefined ? filter : { ...filter, deletedAt: null },
    );
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
    // Cap results to prevent unbounded scans on large tenants
    const docs = await this.model.find(scopedWhere).limit(50).exec();
    return docs.map((doc) => this.mapToDomain(doc));
  }

  /**
   * Exact-match lookup for one identity value, used to enforce the tenant's
   * uniqueEmail / uniquePhone policy.
   *
   * Exact equality, not the case-insensitive regex `checkDuplicate` uses: both
   * sides are normalised at the edge now, so a regex here would only add an
   * un-indexable scan. Backed by `tenantId + emails` / `tenant_phone_lookup`.
   *
   * Scoped by `applyTenantFilter`, which also applies the visibility axes — so a
   * conflict with a contact the caller cannot see reports as no conflict, and the
   * write proceeds. That is the intended trade-off: leaking the existence of an
   * out-of-scope record through a uniqueness error would be worse than allowing
   * a duplicate that a dedup scan can find later.
   */
  async findDuplicateByIdentity(
    field: 'emails' | 'phones',
    value: string,
    excludeId?: string,
  ): Promise<Contact | null> {
    const where: FilterQuery<ContactSchemaClass> = {
      [field]: value,
      deletedAt: null,
    };
    if (excludeId) where._id = { $ne: excludeId };

    const doc = await this.model
      .findOne(this.applyTenantFilter(where))
      .select({ firstName: 1, lastName: 1, emails: 1, phones: 1 })
      .lean()
      .exec();
    return doc ? this.mapToDomain(doc as any) : null;
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
      deletedAt: null,
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

  /**
   * Soft-delete a contact.
   *
   * Overrides the base implementation, which issues `deleteOne` — a HARD delete.
   * That was wrong in three separate ways for this collection: every read here
   * filters `deletedAt: { $exists: false }`, the schema declares a `deletedAt`
   * field, and merge already soft-deletes. So the domain was written as if
   * delete were reversible while the one method that performs it destroyed the
   * document, orphaning notes, tickets, deals, tasks, conversations, email
   * bodies and the activity feed with no way to repair them, and making the
   * audit trail's `_deleted: true` snapshot a claim about a row that no longer
   * existed.
   *
   * Hard deletion now happens only in ContactPurgeService, after the retention
   * window, and cascades through CONTACT_REFERENCES.
   */
  async remove(id: string): Promise<void> {
    const removed = await this.removeIfExists(id);
    if (!removed) {
      throw new NotFoundException(this.notFoundMessage(id));
    }
  }

  async removeIfExists(id: string): Promise<boolean> {
    const scopedFilter = this.applyTenantFilter({ _id: id });
    const deletedById = this.cls.get('userId') ?? this.cls.get('user.id');
    const result = await this.model
      .updateOne(scopedFilter, {
        $set: {
          deletedAt: new Date(),
          ...(deletedById ? { updatedById: deletedById } : {}),
        },
      })
      .exec();
    return result.matchedCount > 0;
  }

  protected notFoundMessage(id: string): string {
    return `Contact ${id} not found`;
  }

  /** Restore a soft-deleted contact from the recycle bin. */
  async restore(id: string): Promise<Contact | null> {
    const scopedFilter = this.applyTenantFilter({
      _id: id,
      deletedAt: { $ne: null },
    });
    const doc = await this.model
      .findOneAndUpdate(
        scopedFilter,
        { $unset: { deletedAt: '' } },
        { new: true },
      )
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  /**
   * List soft-deleted contacts — the recycle bin.
   * Scoped and paginated like any other read; a deleted record is still the
   * tenant's data and still subject to the visibility axes.
   */
  async findDeleted(options: {
    page: number;
    limit: number;
  }): Promise<{ data: Contact[]; total: number }> {
    const scopedWhere = this.applyTenantFilter({
      deletedAt: { $ne: null },
    } as FilterQuery<ContactSchemaClass>);

    const [docs, total] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ deletedAt: -1 })
        .skip((options.page - 1) * options.limit)
        .limit(options.limit)
        .populate('owner')
        .populate('updatedBy')
        .exec(),
      this.model.countDocuments(scopedWhere).limit(1001).exec(),
    ]);

    return { data: docs.map((doc) => this.mapToDomain(doc)), total };
  }

  /**
   * Contacts soft-deleted before `cutoff`, for the purge job.
   *
   * Runs WITHOUT the tenant filter by design: the purge cron has no request
   * context, and retention has to apply to every tenant. `applyTenantFilter`
   * would silently return nothing in that context, which is the quiet-failure
   * mode where a retention policy appears to run and never deletes anything.
   */
  async findPurgeable(
    cutoff: Date,
    limit: number,
  ): Promise<Array<{ id: string; tenantId: string }>> {
    const docs = await this.model
      .find({ deletedAt: { $ne: null, $lte: cutoff } })
      // The tenant plugin THROWS when CLS has no tenant, and a cron has no request
      // context — so without this the nightly purge failed on its first query every
      // night and the failure was swallowed as "purge skipped" at debug level.
      .setOptions({ isPlatformQuery: true } as any)
      .select({ _id: 1, tenantId: 1 })
      .sort({ deletedAt: 1 })
      .limit(limit)
      .lean()
      .exec();
    return docs.map((doc: any) => ({
      id: String(doc._id),
      tenantId: String(doc.tenantId),
    }));
  }

  /** Hard-delete a single contact. Only ContactPurgeService may call this. */
  async hardDelete(id: string): Promise<void> {
    // Platform-level for the same reason as findPurgeable: the caller is a cron.
    // `deleteOne` is one of the hooked operations, so an unmarked call throws.
    await this.model
      .deleteOne({ _id: id })
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
  }

  async updateWithVersionCheck(
    id: string,
    version: number,
    data: Partial<ContactSchemaClass>,
    session?: ClientSession,
  ): Promise<Contact | null> {
    const scopedFilter = this.applyTenantFilter({ _id: id, __v: version });
    const updatedById = this.cls.get('userId') ?? this.cls.get('user.id');
    let query = this.model.findOneAndUpdate(
      scopedFilter,
      {
        $set: {
          ...data,
          ...(updatedById ? { updatedById } : {}),
        },
        $inc: { __v: 1 },
      },
      { new: true, ...(session ? { session } : {}) },
    );
    if (session) query = query.session(session);
    const doc = await query.exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  /**
   * Recompute lead scores for a page of contacts.
   *
   * `afterId` is a resume cursor and it is not optional in practice: the previous
   * version issued `.find({...}).limit(5000)` with no sort and no cursor, so
   * every nightly run scored the same first 5,000 documents in natural order and
   * never reached the rest. On any tenant past that size the job appeared healthy
   * — it logged `scanned=5000, updated=N` every night — while most contacts kept
   * a score of 0 forever. Sorting by `_id` and resuming after the last one
   * processed is what makes the pass actually cover the collection.
   *
   * Returns `nextCursor` so the caller can keep going until it is null.
   */
  async recomputeScoresForAllTenants(
    limit: number,
    afterId?: string,
  ): Promise<{ scanned: number; updated: number; nextCursor: string | null }> {
    const filter: FilterQuery<ContactSchemaClass> = { deletedAt: null };
    if (afterId) filter._id = { $gt: new Types.ObjectId(afterId) };

    const docs = await this.model
      .find(filter)
      // Cross-tenant by design (the comment above says so) — but "by design" was not
      // enough: the tenant plugin throws without CLS, so the nightly rescore threw on
      // this query and never scored anything. Intent has to be declared to the plugin.
      .setOptions({ isPlatformQuery: true } as any)
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
      // `_id` is monotonic and unique, so it is a stable cursor even while rows
      // are being inserted during the run.
      .sort({ _id: 1 })
      .limit(limit)
      .lean()
      .exec();

    if (docs.length === 0) {
      return { scanned: 0, updated: 0, nextCursor: null };
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
      // A short page means the collection is exhausted; anything else means
      // there is more to do and the caller must come back with this cursor.
      nextCursor:
        docs.length < limit ? null : String((docs[docs.length - 1] as any)._id),
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
        // Full history is projected to contact_stage_transitions. Keep only a
        // bounded compatibility tail on the aggregate to avoid 16MB growth.
        $push: { stageHistory: { $each: [entry], $slice: -100 } },
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
