import {
  BadRequestException,
  Injectable,
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
import { applySearchKeys } from '../../../../../common/search/search-keys.query';
import {
  compileContactFilter,
  parseContactFilter,
} from '../../../../filters/contact-filter';
import { CONTACT_SORTABLE_FIELDS } from '../../../../dto/query-contact.dto';
import { storagePathForSort } from '../../../../../object-manager/sortable-fields';

@Injectable()
export class ContactRepository extends BaseDocumentRepository<
  ContactSchemaDocument,
  Contact
> {
  private readonly cursorSortableFields = new Set<string>(
    CONTACT_SORTABLE_FIELDS,
  );

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
   * Apply the legacy `data_access_policy.restrict_own_contacts` flag.
   *
   * Written into `$and` rather than onto `where.ownerId` directly. The bare-key
   * form was overwritable: a client-supplied `{ field: 'owner' }` filter maps onto
   * the SAME `ownerId` key, so a user in a restricted tenant could read other
   * people's contacts just by sending a filter. An `$and` clause cannot be
   * overwritten by a later assignment — the two conditions intersect instead,
   * which is what "restrict" has to mean. (The compiler now emits every user
   * condition into `$and` for the same reason.)
   */
  private applyOwnerRestriction(
    where: FilterQuery<ContactSchemaClass>,
    filterOptions: any,
  ): void {
    const currentUserId = filterOptions.__currentUserId;
    if (!currentUserId) return;
    where.$and = [...((where.$and as any[]) ?? []), { ownerId: currentUserId }];
  }

  /**
   * Free-text search over the contact list.
   *
   * Three mechanisms used to live here — `$text` for names, equality for a
   * full e-mail, an anchored prefix regex for a phone number — and between them
   * they still could not find a contact by company, job title, tag or custom
   * field, could not match a partially typed name, and treated `أحمد` and
   * `احمد` as different people. `searchKeys` replaces all three with one
   * index-backed prefix match over canonically folded tokens.
   *
   * The e-mail and phone fast paths are gone, not merely rewritten. They read
   * fields that field masking hides, so they let a user without
   * `contacts:unmask` use a protected value as a lookup key. Those tokens now
   * live in `searchKeysPii`, which `includeSensitive` gates.
   */
  private applySearchFilter(
    where: FilterQuery<ContactSchemaClass>,
    search: string,
    canSearchSensitive: boolean,
  ): void {
    applySearchKeys(where as Record<string, any>, search, {
      includeSensitive: canSearchSensitive,
    });
  }

  /**
   * True when this list request carries a free-text search.
   *
   * Used to skip the companion count. The search itself is now index-backed,
   * but the count still re-executes the whole match for a number the UI renders
   * as "25+" — the most expensive thing a search request does, done twice, for
   * a figure nobody reads precisely.
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
        // Absent means "no", so a caller that forgets to resolve the permission
        // gets the narrower search rather than the wider one.
        filterOptions.__canSearchSensitive === true,
      );
    }

    if (filterOptions?.lifecycleStage) {
      where.lifecycleStageId = filterOptions.lifecycleStage;
    }

    // The account detail page's "Contacts" list. The UI has always sent this and
    // the query DTO never declared it, so `forbidNonWhitelisted` rejected the
    // whole request with a 422 — the related list could not load at all, even
    // though `tenant_account_lookup` was built to serve it.
    if (filterOptions?.accountId) {
      where.accountId = new Types.ObjectId(String(filterOptions.accountId));
    }

    // Segment membership, already compiled by ContactSegmentsService. Composed
    // here rather than replacing the filter, so a segment can be narrowed
    // further by the list's own search and filters.
    if (filterOptions?.__segmentFilter) {
      (where.$and as any[]) = [
        ...((where.$and as any[]) ?? []),
        filterOptions.__segmentFilter,
      ];
    }

    // Resolved once per request by ContactsService from the tenant's
    // custom_fields registry; absent means custom-field filters are refused.
    const group = parseContactFilter(filterOptions?.filters);
    const compiled = group
      ? compileContactFilter(group, filterOptions?.__allowedCustomFieldKeys)
      : null;
    if (compiled) {
      (where.$and as any[]) = [...((where.$and as any[]) ?? []), compiled];
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

    // Offset mode used to hard-code `createdAt: -1` and ignore `sortBy`, so
    // clicking a column header in a non-cursor list re-sorted nothing. Same
    // whitelist as cursor mode, plus `_id` as the tie-breaker the indexes carry.
    const sortField = this.resolveCursorSortField(filterOptions?.sortBy);
    const sortDirection =
      normalizeSortOrder(filterOptions?.sortOrder) === 'asc' ? 1 : -1;

    const [docs, countResult] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ [sortField]: sortDirection, _id: sortDirection })
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

  /**
   * The document path to sort on.
   *
   * `name` is the one that needs translating: the list's primary column is
   * composed by the mapper from `firstName` + `lastName` and no document holds
   * it, so sorting it means sorting `firstName`. Anything outside the whitelist
   * falls back to `createdAt` rather than reaching Mongo unindexed.
   */
  private resolveCursorSortField(sortBy?: string): string {
    if (!sortBy || !this.cursorSortableFields.has(sortBy)) return 'createdAt';
    return storagePathForSort('Contact', sortBy);
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
    // Archived contacts must not surface as duplicates: the warning would point
    // at a record in the recycle bin that the user cannot open, and the omni
    // resolver would attach a live conversation to a deleted person.
    const where: FilterQuery<ContactSchemaClass> = { deletedAt: null };

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
      deletedAt: null,
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
   * Live contacts by id, scoped — the "before" snapshot a bulk write needs.
   *
   * Bulk operations go through `updateMany`, which produces no audit diff and no
   * automation event, so the caller has to read the rows itself to know what
   * changed. Returning only what the caller may see also means a bulk write can
   * never touch a record outside their scope.
   */
  async findByIds(ids: string[], session?: ClientSession): Promise<Contact[]> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length === 0) return [];

    const scopedFilter = this.applyTenantFilter({
      _id: { $in: valid.map((id) => new Types.ObjectId(id)) },
      deletedAt: null,
    } as FilterQuery<ContactSchemaClass>);

    const docs = await this.model
      .find(scopedFilter)
      .session(session ?? null)
      .exec();
    return docs.map((doc) => this.mapToDomain(doc));
  }

  /**
   * How many live contacts a segment predicate selects, and a handful of them.
   *
   * Scoped like every other read: a segment preview must count what the caller
   * can actually see, or a rep building an audience sees a number they will not
   * get. Capped so building a segment never runs an unbounded count — past the
   * cap the UI says "10,000+", which is the same contract the list view uses.
   */
  async previewSegment(
    membership: FilterQuery<ContactSchemaClass>,
    sampleSize: number,
    countLimit = 10_000,
  ): Promise<{ total: number; isExactCount: boolean; sample: Contact[] }> {
    const scopedWhere = this.applyTenantFilter({
      $and: [{ deletedAt: null }, membership],
    } as FilterQuery<ContactSchemaClass>);

    const [count, docs] = await Promise.all([
      this.countDocumentsWithCap(scopedWhere, countLimit),
      sampleSize > 0
        ? this.model
            .find(scopedWhere)
            .sort({ createdAt: -1 })
            .limit(sampleSize)
            .select({ firstName: 1, lastName: 1, emails: 1, phones: 1 })
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);

    return {
      total: count.totalItems,
      isExactCount: count.isExactCount,
      sample: (docs as any[]).map((doc) => this.mapToDomain(doc)),
    };
  }

  async addTagsToContacts(
    contactIds: string[],
    tags: string[],
    session?: ClientSession,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const scopedFilter = this.applyTenantFilter({
      _id: { $in: contactIds },
      deletedAt: null,
    } as FilterQuery<ContactSchemaClass>);
    const result = await this.model
      .updateMany(scopedFilter, {
        $addToSet: { tags: { $each: tags } },
      })
      .session(session ?? null)
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
   * One page of contacts across every tenant, for the nightly rescore.
   *
   * `afterId` is a resume cursor and it is not optional in practice: an earlier
   * version issued `.find({...}).limit(5000)` with no sort and no cursor, so
   * every nightly run processed the same first 5,000 documents in natural order
   * and never reached the rest. `_id` is monotonic and unique, so it stays a
   * stable cursor even while rows are inserted during the run.
   *
   * This method deliberately does NOT compute a score. It used to, with its own
   * recency+completeness formula, which meant the nightly job overwrote whatever
   * the tenant's Lead Scoring rules had produced. Scoring belongs to
   * LeadScoringService; this is the paged read it consumes.
   */
  async findPageForScoring(
    limit: number,
    afterId?: string,
  ): Promise<{
    contacts: Array<Record<string, any>>;
    nextCursor: string | null;
  }> {
    const filter: FilterQuery<ContactSchemaClass> = { deletedAt: null };
    if (afterId) filter._id = { $gt: new Types.ObjectId(afterId) };

    const docs = await this.model
      .find(filter)
      // Cross-tenant by design — but "by design" was not enough: the tenant plugin
      // throws without CLS, so the nightly rescore threw on this query and never
      // scored anything. Intent has to be declared to the plugin.
      .setOptions({ isPlatformQuery: true } as any)
      .sort({ _id: 1 })
      .limit(limit)
      .lean()
      .exec();

    return {
      contacts: docs as Array<Record<string, any>>,
      nextCursor:
        docs.length < limit ? null : String((docs[docs.length - 1] as any)._id),
    };
  }

  /**
   * Apply computed scores in one round-trip.
   *
   * `bulkWrite` is not one of the tenant plugin's hooked operations, so each
   * filter carries its own `tenantId`: an id-only filter here would be a
   * cross-tenant write path with nothing above it to catch a mis-paired row.
   */
  async applyScores(
    scores: Array<{ id: unknown; tenantId: unknown; score: number }>,
  ): Promise<number> {
    if (scores.length === 0) return 0;
    const result = await this.model.bulkWrite(
      scores.map(({ id, tenantId, score }) => ({
        updateOne: {
          filter: { _id: id as any, tenantId: tenantId as any },
          update: { $set: { score } },
        },
      })),
      { ordered: false } as any,
    );
    return result.modifiedCount;
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
