import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types } from 'mongoose';
import { TaskSchemaClass, TaskSchemaDocument } from '../entities/task.schema';
import { TaskStatusSchemaClass } from '../../../../../task-settings/entities/task-status.schema';
import { Task } from '../../../../domain/task';
import { TaskMapper } from '../mappers/task.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { VisibilityModule } from '../../../../../common/permissions/visibility-modules';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';
import { escapeRegex } from '../../../../../utils/escape-regex';
import { applyRegisteredCustomFieldFilters } from '../../../../../utils/custom-field-filter';
import { TaskListFilter } from '../../../../dto/task-list-query.dto';

const normalizeListFilter = (value: unknown): string[] =>
  (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .slice(0, 100);

/**
 * A syntactically valid ObjectId that no document carries, used to force an
 * empty result set.
 *
 * `statusId: {$in: []}` would work too, but an all-zero id survives the
 * ObjectId cast that a `$in: []` on a typed path can trip over, and it reads in
 * a query log as a deliberate "match nothing" rather than a bug.
 */
const NO_MATCH_ID = '000000000000000000000000';

/**
 * Ceiling for the list count. Past this the pager reports "10.000+".
 */
const COUNT_CAP = 10_001;

@Injectable()
export class TaskRepository extends BaseDocumentRepository<
  TaskSchemaDocument,
  Task
> {
  constructor(
    @InjectModel(TaskSchemaClass.name)
    taskModel: Model<TaskSchemaDocument>,
    @InjectModel(TaskStatusSchemaClass.name)
    private readonly statusModel: Model<any>,
    cls: ClsService,
  ) {
    super(taskModel, cls);
  }

  /** Tagged so a tenant can scope tasks differently from other modules. */
  protected visibilityModule(): VisibilityModule {
    return 'Task';
  }

  protected mapToDomain(doc: TaskSchemaClass): Task {
    return TaskMapper.toDomain(doc);
  }

  protected toPersistence(domain: Task): TaskSchemaClass {
    return TaskMapper.toPersistence(domain);
  }

  /**
   * The single filter builder for every task read: list, export and count.
   *
   * There used to be two — `buildSynchronousListWhere` for export and an inline
   * block inside `findManyWithPagination` for the list — and they had drifted
   * apart. Export honoured only `filters[]` and `search`, silently ignoring
   * `statusIds`, `priorities`, `dueFrom`, `dueTo` and `contactId`. So a user who
   * filtered a view down to nine overdue tasks and pressed Export received a
   * file containing the whole collection: the same class of defect the search
   * capability registry calls out when it puts export in tier E, except adding
   * rows rather than dropping them.
   *
   * Fully synchronous by design. The one input that needed a database round-trip
   * — resolving status `apiName`s to ids — is resolved by `resolveStatusIds()`
   * before the builder runs, so the export path (whose cursor is opened
   * synchronously) and the list path can share this code unchanged.
   */
  private buildWhere(
    filterOptions?: TaskListFilter,
  ): FilterQuery<TaskSchemaClass> {
    // `deletedAt: null` matches both a missing field and an explicit null, which
    // `{$exists: false}` does not. The two builders disagreed on this too.
    const where: FilterQuery<TaskSchemaClass> = { deletedAt: null };

    if (filterOptions?.search) {
      // Escaped: the value is user input becoming a regex. Escaping removes the
      // ReDoS risk but not the scan — see the `task_list_search` capability for
      // where this is headed.
      const expression = {
        $regex: escapeRegex(filterOptions.search),
        $options: 'i',
      };
      where.$or = [{ title: expression }, { description: expression }];
    }

    const explicitStatusIds = normalizeListFilter(filterOptions?.statusIds);
    if (explicitStatusIds.length > 0) {
      where.statusId = { $in: explicitStatusIds } as any;
    }

    const priorities = normalizeListFilter(filterOptions?.priorities).map(
      (priority) => priority.toUpperCase(),
    );
    if (priorities.length > 0) {
      where.priority = { $in: priorities } as any;
    } else if (filterOptions?.priority) {
      where.priority = String(filterOptions.priority).toUpperCase();
    }

    const ownerIds = normalizeListFilter(filterOptions?.ownerIds);
    if (ownerIds.length > 0) {
      where.ownerId = { $in: ownerIds } as any;
    }

    const dueFrom = this.parseDate(filterOptions?.dueFrom);
    const dueTo = this.parseDate(filterOptions?.dueTo);
    if (dueFrom || dueTo) {
      where.dueDate = {
        ...(dueFrom ? { $gte: dueFrom } : {}),
        ...(dueTo ? { $lte: dueTo } : {}),
      };
    }

    if (filterOptions?.contactId) {
      where.$and = [
        ...((where.$and as any[]) || []),
        { 'relatedTo.type': 'Contact' },
        {
          // Two spellings because historical rows stored `relatedTo.id` while
          // the mapper now writes `relatedTo._id`.
          $or: [
            { 'relatedTo._id': filterOptions.contactId },
            { 'relatedTo.id': filterOptions.contactId },
          ],
        },
      ];
    }

    this.applyTableFilters(where, filterOptions?.filters);

    applyRegisteredCustomFieldFilters(
      where,
      filterOptions?.filters,
      filterOptions?.__customFieldDefinitions,
    );
    return where;
  }

  /**
   * Fail loudly if a read is about to include soft-deleted rows.
   *
   * The soft-delete predicate lives in `buildWhere`, shared by the list and the
   * export so the two cannot disagree. That centralisation costs something: the
   * `deletedAt` filter is no longer visible at the call site, so neither a reader
   * of `findManyWithPagination` nor the static check in
   * `soft-delete-read-inventory.spec.ts` can see that it is applied.
   *
   * This restores the guarantee as an executable one instead of a textual one. It
   * is not decoration — it converts "somebody edited `buildWhere` and dropped the
   * predicate" from a silent leak of deleted records into a failed request, which
   * is the correct direction for a mistake of that shape to fail in.
   */
  private assertFilterConstrains(
    field: 'deletedAt',
    filter: FilterQuery<TaskSchemaClass>,
  ): FilterQuery<TaskSchemaClass> {
    if (!JSON.stringify(filter).includes(field)) {
      throw new Error(
        `[TaskRepository] Refusing a read with no ${field} predicate — ` +
          'soft-deleted tasks would be served. Check buildWhere().',
      );
    }
    return filter;
  }

  private parseDate(value: unknown): Date | null {
    if (!value) return null;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  /** TanStack-table filter descriptors, which saved views persist as JSON. */
  private applyTableFilters(
    where: FilterQuery<TaskSchemaClass>,
    rawFilters: unknown,
  ): void {
    const filters =
      typeof rawFilters === 'string'
        ? (() => {
            try {
              return JSON.parse(rawFilters);
            } catch {
              // A malformed saved view must not fail the request; it filters
              // nothing, which is what the previous builder did too.
              return [];
            }
          })()
        : rawFilters;
    if (!Array.isArray(filters)) return;

    for (const filter of filters) {
      if (!filter?.id || filter.value === undefined || filter.value === '') {
        continue;
      }
      if (String(filter.id).startsWith('customFields.')) continue;

      if (filter.id === 'status' || filter.id === 'statusId') {
        const values = normalizeListFilter(filter.value);
        if (values.length > 0) {
          where.statusId =
            values.length > 1 ? ({ $in: values } as any) : values[0];
        }
      } else if (filter.id === 'priority') {
        const values = normalizeListFilter(filter.value).map((value) =>
          value.toUpperCase(),
        );
        if (values.length > 0) {
          where.priority =
            values.length > 1 ? ({ $in: values } as any) : values[0];
        }
      } else if (['owner', 'createdBy', 'updatedBy'].includes(filter.id)) {
        // No 'assignedTo' entry: Task has exactly one person axis, `ownerId`.
        // The old mapping pointed at `assignedToId`, a field no schema ever
        // declared, so that filter silently matched zero rows — and its sibling
        // `populate('assignedTo')` threw StrictPopulateError on every non-empty
        // read until it was removed.
        const field = (
          {
            owner: 'ownerId',
            createdBy: 'createdById',
            updatedBy: 'updatedById',
          } as Record<string, string>
        )[filter.id];
        // normalizeListFilter, not the raw value: it trims, drops blanks and
        // caps at 100 entries. The unbounded `$in` this replaced let a caller
        // hand Mongo an arbitrarily long array.
        const values = normalizeListFilter(filter.value);
        if (values.length > 0) {
          where[field] = values.length > 1 ? { $in: values } : values[0];
        }
      }
    }
  }

  /**
   * Resolve status `apiName`s to ObjectIds.
   *
   * Tenant-scoped by the plugin, so this can only ever return this tenant's
   * statuses. Returns `[]` when the names match nothing, which the caller must
   * treat as "no rows" rather than "no filter" — dropping the predicate would
   * widen the result set on a typo.
   */
  async resolveStatusIds(statusNames: string): Promise<string[]> {
    const names = normalizeListFilter(statusNames);
    if (names.length === 0) return [];
    const docs = await this.statusModel
      .find({ apiName: { $in: names } })
      .select('_id')
      .lean()
      .exec();
    return docs.map((doc: any) => String(doc._id));
  }

  private buildExportFilter(params: { ids?: string[]; filters?: any }) {
    if (params.ids?.length) {
      return this.assertFilterConstrains(
        'deletedAt',
        this.applyTenantFilter({
          _id: {
            $in: params.ids
              .filter((id) => Types.ObjectId.isValid(id))
              .map((id) => new Types.ObjectId(id)),
          },
          deletedAt: null,
        } as FilterQuery<TaskSchemaClass>),
      );
    }
    return this.assertFilterConstrains(
      'deletedAt',
      this.applyTenantFilter(this.buildWhere(params.filters)),
    );
  }

  streamForExport(
    params: { ids?: string[]; filters?: any },
    opts?: {
      projection?: Record<string, 1>;
      readPreference?: string;
      batchSize?: number;
    },
  ): AsyncIterable<any> & { close(): Promise<void> } {
    const query = this.model
      .find(this.buildExportFilter(params))
      .sort({ dueDate: 1, createdAt: -1 })
      .lean();
    if (opts?.projection) query.select(opts.projection);
    if (opts?.readPreference) query.read(opts.readPreference as any);
    return query.batchSize(opts?.batchSize ?? 1000).cursor();
  }

  async countForExport(
    params: { ids?: string[]; filters?: any },
    maxTimeMS?: number,
  ): Promise<number> {
    const query = this.model.countDocuments(this.buildExportFilter(params));
    if (maxTimeMS) query.maxTimeMS(maxTimeMS);
    return query.exec();
  }

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: TaskListFilter;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Task>> {
    const resolved: TaskListFilter = { ...(filterOptions ?? {}) };

    // `status` carries apiNames; the stored field is an ObjectId. Resolve before
    // building so the builder itself stays synchronous and shareable with export.
    if (
      normalizeListFilter(resolved.statusIds).length === 0 &&
      resolved.status
    ) {
      const statusIds = await this.resolveStatusIds(resolved.status);
      // An unmatched name must narrow to nothing, not widen to everything: a
      // typo in a saved view should show zero rows, not the whole collection.
      resolved.statusIds = statusIds.length > 0 ? statusIds : [NO_MATCH_ID];
    }

    const scopedWhere = this.assertFilterConstrains(
      'deletedAt',
      this.applyTenantFilter(this.buildWhere(resolved)),
    );

    const [docs, totalItems] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort(this.buildSort(resolved))
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('owner', 'firstName lastName photo email')
        .populate('taskStatus')
        .populate('taskCategory')
        .populate('taskSource')
        .exec(),
      // Capped. The count exists to drive a pager, and an exact count over a
      // filter that scans (free-text search, `relatedTo` lookups) costs as much
      // as the page itself while telling the user nothing they act on — `find`
      // at least stops at `limit`. The recycle bin already made this trade;
      // the main list had not.
      this.model.countDocuments(scopedWhere).limit(COUNT_CAP).exec(),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc)),
      totalItems,
      paginationOptions,
    );
  }

  /**
   * Sort spec, always ending in `_id`.
   *
   * `_id` is the tie-breaker that makes skip-based pagination stable: without a
   * unique final key, two documents sharing a `dueDate` can swap places between
   * requests for page 1 and page 2, so a row is served twice and another never.
   */
  private buildSort(filterOptions?: TaskListFilter): Record<string, 1 | -1> {
    const direction: 1 | -1 = filterOptions?.sortOrder === 'desc' ? -1 : 1;
    switch (filterOptions?.sortBy) {
      case 'createdAt':
        // Served by `task_list_created`. The DTO restricts `sortBy` to the fields
        // that have an index, so this switch has no unindexed branch.
        return { createdAt: direction, _id: direction };
      default:
        return { dueDate: direction, _id: direction };
    }
  }

  async findOne(filter: FilterQuery<TaskSchemaClass>): Promise<Task | null> {
    // Exclude soft-deleted tasks unless the caller asked for one explicitly.
    //
    // The list query at `buildListWhere` has always filtered these; `findOne` did
    // not, which did not show while `remove()` hard-deleted (the row was simply
    // gone, so a fetch 404'd). Now that deletion is a soft delete, an unfiltered
    // `findOne` would serve a deleted task on its detail page instead of 404 —
    // and, worse, let it be edited back into visibility.
    const scopedFilter = this.applyTenantFilter(
      filter.deletedAt !== undefined ? filter : { ...filter, deletedAt: null },
    );
    const doc = await this.model
      .findOne(scopedFilter)
      .populate('owner', 'firstName lastName photo email')
      .populate('taskStatus')
      .populate('taskCategory')
      .populate('taskSource')
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  /**
   * Records soft-deleted before `cutoff`, for the retention purge.
   *
   * `isPlatformQuery` because the caller is a cron: retention applies to every tenant, and
   * without the flag `tenantFilterPlugin` throws on a missing CLS tenant — which is how
   * four nightly jobs came to fail on their first query while logging "skipped".
   *
   * Oldest deletion first, so a backlog drains in the order it accumulated.
   */
  async findPurgeable(
    cutoff: Date,
    limit: number,
  ): Promise<Array<{ id: string; tenantId: string }>> {
    const docs = await this.model
      .find({ deletedAt: { $ne: null, $lte: cutoff } })
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

  /** Hard-delete one task. Only TaskPurgeService may call this. */
  async hardDelete(id: string): Promise<void> {
    await this.model
      .deleteOne({ _id: id })
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
  }
}
