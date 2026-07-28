import { ConflictException, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ClientSession, Model, Document, FilterQuery } from 'mongoose';

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
   * Auto-enriches data with multitenant context from CLS:
   *   - tenantId    → cls.tenantId   (MongoDB ObjectId)
   *   - createdById → cls.userId     (MongoDB ObjectId)
   *   - updatedById → cls.userId     (MongoDB ObjectId)
   *
   * Existing values in data are NOT overwritten.
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

  protected applyTenantFilter(
    filter: FilterQuery<TSchema> = {},
  ): FilterQuery<TSchema> {
    let enriched: any = { ...filter };
    // ── Data Visibility Filter ──────────────────────────────────────────────
    // visibleOwnerIds is set by DataVisibilityInterceptor:
    //   undefined → not evaluated (skip)
    //   null      → admin/owner bypass (see all)
    //   string[]  → filter to these owner IDs only
    if (this.enableDataVisibility()) {
      const { visibleOwnerIds, visibleOrgUnitIds } = this.resolveVisibility();
      if (Array.isArray(visibleOwnerIds)) {
        // C3: by default, unowned records (ownerId null/missing) are NOT
        // visible to scoped users — they only leak when the tenant explicitly
        // opts in (includeUnownedInScope). Admins bypass this entirely
        // (visibleOwnerIds === null). This closes the "null owner → visible to
        // everyone" data leak.
        const ownerClauses: any[] = [{ ownerId: { $in: visibleOwnerIds } }];
        if (this.cls.get('includeUnownedInScope') === true) {
          ownerClauses.push({ ownerId: null }); // covers null and missing field
        }

        // H-07: the org-unit axis, UNIONED with the owner axis.
        //
        // Union, not intersection. ORG_UNIT scope means "my records AND my
        // unit's records" — a manager keeps seeing what they own even if they
        // are personally unassigned to a unit, and keeps seeing a subordinate in
        // another unit. Intersecting would make a wider scope return fewer rows,
        // which is the surprise that makes scope models untrustworthy.
        //
        // An EMPTY array adds nothing: it is what an unassigned user, or a
        // SELF/SUBORDINATES scope, produces. It must not be turned into an
        // `$in: []` clause of its own, which matches no rows and would erase the
        // owner clause it was meant to widen.
        if (Array.isArray(visibleOrgUnitIds) && visibleOrgUnitIds.length > 0) {
          ownerClauses.push({ orgUnitId: { $in: visibleOrgUnitIds } });
        }

        enriched = {
          ...enriched,
          $and: [...(enriched.$and || []), { $or: ownerClauses }],
        };
      }
      // null or undefined → no additional filter
    }

    return enriched;
  }

  /**
   * Override in subclasses to disable data visibility filtering.
   * Default: true for CRM entities. Override to false for User, Settings, etc.
   */
  protected enableDataVisibility(): boolean {
    return true;
  }

  /**
   * The module key this repository's records belong to ('Contact', 'Deal', …),
   * or null when the repository is not part of a module a tenant can configure
   * separately.
   *
   * Exists so one tenant can say "tickets are visible to the whole department,
   * deals are not". Without it every module shares one scope, which forces an
   * admin to pick the widest setting any module needs and apply it to all of
   * them — the reason coarse visibility models get abandoned.
   */
  protected visibilityModule(): string | null {
    return null;
  }

  /**
   * The owner/org-unit axes to enforce for THIS repository.
   *
   * Falls back to the request-wide values whenever the tenant has configured
   * nothing module-specific, so a repository that never overrides
   * `visibilityModule()` behaves exactly as before. A per-module entry replaces
   * the base pair wholesale rather than merging: the interceptor already
   * computed it as a complete answer for that module, including sharing rules
   * scoped to it.
   */
  private resolveVisibility(): {
    visibleOwnerIds: unknown;
    visibleOrgUnitIds: unknown;
  } {
    const moduleKey = this.visibilityModule();
    if (moduleKey) {
      const byModule = this.cls.get('dataVisibilityByModule') as
        | Record<
            string,
            { ownerIds: string[] | null; orgUnitIds: string[] | null }
          >
        | undefined;
      const override = byModule?.[moduleKey];
      if (override) {
        return {
          visibleOwnerIds: override.ownerIds,
          visibleOrgUnitIds: override.orgUnitIds,
        };
      }
    }
    return {
      visibleOwnerIds: this.cls.get('visibleOwnerIds'),
      visibleOrgUnitIds: this.cls.get('visibleOrgUnitIds'),
    };
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

    // Apply tenant filter
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
      const exists = await this.model.exists({ _id: id });
      if (exists) {
        throw new ConflictException(
          'Dữ liệu đã bị thay đổi bởi người dùng khác. Vui lòng tải lại.',
        );
      }
    }

    return updated ? this.mapToDomain(updated) : null;
  }

  async remove(id: string): Promise<void> {
    const filter = this.applyTenantFilter({ _id: id } as FilterQuery<TSchema>);
    await this.model.deleteOne(filter);
  }

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

      // H-07: stamp the record with the creator's org unit so ORG_UNIT scopes
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
