import { ConflictException, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ClientSession, Model, Document, FilterQuery } from 'mongoose';

export abstract class BaseDocumentRepository<
  TSchema extends Document,
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
      const visibleOwnerIds = this.cls.get('visibleOwnerIds');
      if (Array.isArray(visibleOwnerIds)) {
        enriched = {
          ...enriched,
          $and: [
            ...(enriched.$and || []),
            {
              $or: [
                { ownerId: { $in: visibleOwnerIds } },
                { ownerId: null }, // covers both null and missing ownerId field
              ],
            },
          ],
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

    const filter: any = { _id: id };

    // Apply tenant filter
    const scopedFilter: any = this.applyTenantFilter(filter);

    if (version !== undefined) {
      scopedFilter.__v = version;
    }

    const updated = (await this.model.findOneAndUpdate(
      scopedFilter,
      {
        ...persistenceData,
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
    }

    if (userId && !enriched.updatedById) {
      enriched.updatedById = userId;
    }

    return enriched;
  }

  protected abstract mapToDomain(doc: TSchema): TDomain;

  protected abstract toPersistence(domain: TDomain): any;
}
