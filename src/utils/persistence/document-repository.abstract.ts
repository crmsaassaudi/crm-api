import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ClientSession, Model, Document, FilterQuery } from 'mongoose';
import { buildVisibilityClauses } from '../../common/permissions/visibility-scope';

export abstract class BaseDocumentRepository<
  TSchema extends Document<any>,
  TDomain,
> {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly model: Model<TSchema>,
    protected readonly cls: ClsService,
  ) {}

  /**
   * Stamps `tenantId`, `createdById` and `updatedById` from CLS. Values already
   * present in `data` are never overwritten.
   */
  async create(
    data: Partial<TDomain>,
    session?: ClientSession,
  ): Promise<TDomain> {
    const enriched = this.enrichWithContext(data, true);
    const created = new this.model(enriched);
    const saved = await created.save({ session });
    return this.mapToDomain(saved);
  }

  /**
   * Intersect a filter with the request's owner / org-unit / ABAC scope.
   *
   * The rule itself lives in `common/permissions/visibility-scope` so that reads
   * which cannot go through a repository — the contact timeline fans in across
   * five collections on the raw connection — enforce the same predicate instead
   * of a second copy of it that drifts.
   */
  protected applyTenantFilter(
    filter: FilterQuery<TSchema> = {},
  ): FilterQuery<TSchema> {
    const enriched: any = { ...filter };
    const clauses = buildVisibilityClauses(
      this.cls,
      this.visibilityModule(),
      this.enableDataVisibility(),
    );
    if (!clauses) return enriched;

    return {
      ...enriched,
      $and: [...(enriched.$and || []), ...clauses],
    };
  }

  /**
   * Override to disable data-visibility filtering. Default true for CRM
   * entities; false for User, Settings and other non-owned collections.
   */
  protected enableDataVisibility(): boolean {
    return true;
  }

  /**
   * The module key this repository's records belong to ('Contact', 'Deal', …),
   * or null when the repository is not part of a module a tenant configures
   * separately.
   *
   * Exists so one tenant can say "tickets are visible to the whole department,
   * deals are not". Without it every module shares one scope, forcing an admin
   * to pick the widest setting any module needs and apply it to all of them —
   * the reason coarse visibility models get abandoned.
   */
  protected visibilityModule(): string | null {
    return null;
  }

  async find(filter: FilterQuery<TSchema>, options?: any): Promise<TDomain[]> {
    const scopedFilter = this.applyTenantFilter(filter);
    const docs = await this.model.find(scopedFilter, null, options);
    return docs.map((doc) => this.mapToDomain(doc as any));
  }

  async findOne(
    filter: FilterQuery<TSchema>,
    session?: ClientSession,
  ): Promise<TDomain | null> {
    const scopedFilter = this.applyTenantFilter(filter);
    const doc = await this.model.findOne(scopedFilter).session(session || null);
    return doc ? this.mapToDomain(doc) : null;
  }

  async count(filter: FilterQuery<TSchema> = {}): Promise<number> {
    const scopedFilter = this.applyTenantFilter(filter);
    return this.model.countDocuments(scopedFilter);
  }

  async exists(filter: FilterQuery<TSchema>): Promise<boolean> {
    const scopedFilter = this.applyTenantFilter(filter);
    const result = await this.model.exists(scopedFilter);
    return !!result;
  }

  /**
   * Auto-enriches payload with updatedBy from CLS if not already set.
   *
   * IMPORTANT — true PATCH semantics:
   * Only the keys present in the incoming `payload` are written to the DB.
   * `toPersistence()` produces a full schema-class instance whose unset
   * fields may carry defaults (e.g. `emails ?? []`).  We use the original
   * payload keys as a whitelist so those defaults never overwrite real data.
   */
  async update(
    id: string,
    payload: Partial<TDomain>,
    session?: ClientSession,
  ): Promise<TDomain> {
    const updated = await this.updateIfExists(id, payload, session);
    if (!updated) {
      throw new NotFoundException(this.notFoundMessage(id));
    }
    return updated;
  }

  /**
   * `update()` without the refusal — returns `null` when the scoped filter
   * matches nothing.
   *
   * For the handful of genuinely idempotent writes (a cleanup cron sweeping
   * rows that another pass may already have removed). Everything reached from
   * an HTTP handler wants `update()`: a scope miss there is an authorization
   * or existence outcome the caller must be told about, not absorbed.
   */
  async updateIfExists(
    id: string,
    payload: Partial<TDomain>,
    session?: ClientSession,
  ): Promise<TDomain | null> {
    const enriched = this.enrichWithContext(payload, false);
    // @ts-expect-error `id` is only present on some domain shapes and is intentionally removed.
    delete enriched.id;

    const persistenceData: any = this.toPersistence(enriched as TDomain);

    const version = persistenceData.__v;
    delete persistenceData.__v;

    // Build a whitelist of keys the caller actually intended to update.
    // This prevents toPersistence() default values (e.g. phones ?? [])
    // from overwriting existing DB data during a partial PATCH.
    const payloadKeys = new Set(Object.keys(enriched as any));
    // Always allow internal bookkeeping fields
    payloadKeys.add('updatedById');

    const $set: Record<string, any> = {};
    for (const [key, value] of Object.entries(persistenceData)) {
      if (payloadKeys.has(key) && value !== undefined) {
        $set[key] = value;
      }
    }

    const filter: any = { _id: id };

    const scopedFilter: any = this.applyTenantFilter(filter);

    if (version !== undefined) {
      scopedFilter.__v = version;
    }

    const updated = (await this.model.findOneAndUpdate(
      scopedFilter,
      {
        $set,
        $inc: { __v: 1 },
      },
      { new: true, session: session || null },
    )) as TSchema;

    if (!updated && version !== undefined) {
      // Scoped, not `{_id: id}`. The tenant plugin already blocks another
      // tenant's row, but a row inside this tenant that the caller cannot SEE
      // (data-visibility / ABAC deny) would answer 409 "someone else changed
      // it" — confirming a record exists to someone with no right to know.
      const exists = await this.model.exists(
        this.applyTenantFilter({ _id: id } as FilterQuery<TSchema>),
      );
      if (exists) {
        throw new ConflictException(
          'Dữ liệu đã bị thay đổi bởi người dùng khác. Vui lòng tải lại.',
        );
      }
    }

    return updated ? this.mapToDomain(updated) : null;
  }

  /**
   * What a scope miss is called in an error message. Overridable so a domain
   * can say "Contact not found" instead of the generic wording.
   */
  protected notFoundMessage(id: string): string {
    return `Record ${id} not found`;
  }

  /**
   * True when this collection models deletion as a `deletedAt` timestamp.
   *
   * Derived from the schema rather than declared per repository, because a
   * repository author forgetting to declare it is exactly how this went wrong:
   * accounts, contacts, deals, notes, tasks and tickets all define `deletedAt`
   * and all filter their reads on it, yet none of them overrode `remove()`, so
   * `DELETE` destroyed the document while the rest of each domain was written as
   * if deletion were reversible. Reading the schema means a collection cannot
   * opt in to a soft-delete contract and then quietly not get one.
   */
  protected get supportsSoftDelete(): boolean {
    return Boolean(this.model.schema?.path('deletedAt'));
  }

  /**
   * Delete a record: a soft delete when the schema has `deletedAt`, otherwise a
   * hard delete.
   *
   * This used to be an unconditional `deleteOne`. For six collections that was a
   * silent contract violation — every read filtered `deletedAt`, the schemas
   * declared it, merge flows set it, and this method destroyed the row anyway.
   * The visible consequences were no recycle bin, unrecoverable mis-clicks,
   * orphaned references in every collection pointing at the deleted id, and audit
   * entries recording a soft delete that had not happened.
   *
   * Collections with no `deletedAt` keep the previous behaviour, so nothing that
   * genuinely wants a hard delete changes.
   *
   * A domain that needs cascade or retention on top of this overrides it —
   * ContactRepository does, together with ContactPurgeService.
   */
  async remove(id: string, session?: ClientSession): Promise<void> {
    const removed = await this.removeIfExists(id, session);
    if (!removed) {
      throw new NotFoundException(this.notFoundMessage(id));
    }
  }

  /**
   * `remove()` without the refusal — returns whether anything matched.
   *
   * `remove()` used to be this, returning `void`. The scoped filter carries the
   * tenant, data-visibility and ABAC-deny predicates, so a delete the caller
   * was not allowed to perform matched zero documents and the handler answered
   * `204 No Content` — reporting a deletion that never happened, for a record
   * still sitting in the database. Silence is the worst possible answer to an
   * authorization question, so the refusal is now the default and absorbing it
   * has to be asked for explicitly.
   */
  async removeIfExists(id: string, session?: ClientSession): Promise<boolean> {
    const filter = this.applyTenantFilter({ _id: id } as FilterQuery<TSchema>);

    if (!this.supportsSoftDelete) {
      // The options argument is passed only when there IS a session, rather than
      // as an always-present `{}`. A session lets a domain commit the delete
      // together with the outbox row announcing it; before that was possible the
      // event and the write were two independent commits and a crash between them
      // lost one of the two.
      const result = session
        ? await this.model.deleteOne(filter, { session })
        : await this.model.deleteOne(filter);
      return result.deletedCount > 0;
    }

    const deletedById = this.cls.get('userId') ?? this.cls.get('user.id');
    const update = {
      $set: {
        deletedAt: new Date(),
        ...(deletedById && this.model.schema?.path('updatedById')
          ? { updatedById: deletedById }
          : {}),
      },
    } as any;
    const result = session
      ? await this.model.updateOne(filter, update, { session })
      : await this.model.updateOne(filter, update);
    return result.matchedCount > 0;
  }

  /**
   * Soft-deleted records awaiting purge — the recycle bin.
   *
   * On the base class for the same reason `remove()` is: soft delete was rolled
   * out across six collections at once, and only contacts got a way back out.
   * For accounts, deals, tickets, tasks and notes the result was worse than the
   * hard delete it replaced — the row stopped being visible anywhere, stopped
   * being recoverable, and (outside contacts, which has a purge job) stayed in
   * the database forever. Soft delete justifies itself by being reversible; a
   * per-domain opt-in is how five of six domains ended up with the cost and none
   * of the benefit.
   *
   * Tenant- and visibility-scoped like every other read: you can only see
   * archived records you could have seen before they were archived.
   */
  async findDeleted(options: {
    page: number;
    limit: number;
  }): Promise<{ data: TDomain[]; total: number }> {
    if (!this.supportsSoftDelete) return { data: [], total: 0 };

    const scopedWhere = this.applyTenantFilter({
      deletedAt: { $ne: null },
    } as FilterQuery<TSchema>);

    const [docs, total] = await Promise.all([
      this.model
        .find(scopedWhere)
        // Newest deletion first: a recycle bin is read to undo something that
        // just happened, not to browse history.
        .sort({ deletedAt: -1 })
        .skip((options.page - 1) * options.limit)
        .limit(options.limit)
        .exec(),
      // Capped: the count drives a pager, and an exact count of a large bin
      // costs a collection scan to tell nobody anything.
      this.model.countDocuments(scopedWhere).limit(1001).exec(),
    ]);

    return { data: docs.map((doc) => this.mapToDomain(doc as TSchema)), total };
  }

  /**
   * Restore a soft-deleted record.
   *
   * `$unset` rather than `deletedAt: null`, because a filter written as
   * `deletedAt: { $exists: false }` — which several repositories use — treats a
   * present-but-null field as still deleted. Restoring to null would leave the
   * record invisible: restored in the database and still gone in the UI.
   */
  async restore(id: string, session?: ClientSession): Promise<TDomain | null> {
    if (!this.supportsSoftDelete) return null;

    const filter = this.applyTenantFilter({
      _id: id,
      deletedAt: { $ne: null },
    } as FilterQuery<TSchema>);

    const doc = await this.model
      .findOneAndUpdate(filter, { $unset: { deletedAt: '' } } as any, {
        new: true,
        ...(session ? { session } : {}),
      })
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  // Deliberately NO base `hardDelete`. Permanent deletion is always a
  // domain-specific retention decision — ContactRepository pairs one with
  // ContactPurgeService and its cascade, FileDocumentRepository has its own with a
  // different signature. A base version would be a third convention for the same
  // concept and would collide with both.

  /**
   * Enriches data with multitenant context from CLS.
   * @param data   - The raw data object
   * @param isCreate - true: set tenant + createdBy + updatedBy; false: only updatedBy
   */
  private enrichWithContext(
    data: Partial<TDomain>,
    isCreate: boolean,
  ): Partial<TDomain> {
    const enriched: any = { ...data };
    const tenantId = this.cls.get('tenantId');
    const userId = this.cls.get('userId');

    if (isCreate) {
      if (tenantId && !enriched.tenantId) {
        enriched.tenantId = tenantId;
      }
      if (userId && !enriched.createdById) {
        enriched.createdById = userId;
      }
      // Auto-assign data owner to creator if not explicitly set
      if (userId && !enriched.ownerId) {
        enriched.ownerId = userId;
      }

      // Stamp the record with the creator's org unit so ORG_UNIT scopes
      // have something to match on. Taken from CLS — resolved once per request
      // by DataVisibilityInterceptor — rather than re-read per insert.
      //
      // Not overwritten when already present: an importer or a transfer flow may
      // legitimately place a record in another unit, and silently rewriting that
      // to the acting user's unit would move data between scopes as a side
      // effect of touching it. Left unset when the creator has no unit, which
      // keeps the record visible via ownerId only — the fail-closed direction.
      const creatorOrgUnitId = this.cls.get('userOrgUnitId');
      if (creatorOrgUnitId && !enriched.orgUnitId) {
        enriched.orgUnitId = creatorOrgUnitId;
      }
    }

    if (userId && !enriched.updatedById) {
      enriched.updatedById = userId;
    }

    return enriched;
  }

  protected abstract mapToDomain(doc: TSchema): TDomain;

  protected abstract toPersistence(domain: TDomain): any;
}
