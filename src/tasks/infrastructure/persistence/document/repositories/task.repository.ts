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

const normalizeListFilter = (value: unknown): string[] =>
  (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .slice(0, 100);

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

  private buildSynchronousListWhere(filterOptions?: any) {
    const where: FilterQuery<TaskSchemaClass> = { deletedAt: null };
    if (filterOptions?.search) {
      const expression = {
        $regex: escapeRegex(filterOptions.search),
        $options: 'i',
      };
      where.$or = [{ title: expression }, { description: expression }];
    }
    const filters =
      typeof filterOptions?.filters === 'string'
        ? (() => {
            try {
              return JSON.parse(filterOptions.filters);
            } catch {
              return [];
            }
          })()
        : filterOptions?.filters;
    if (Array.isArray(filters)) {
      for (const filter of filters) {
        if (!filter?.id || filter.value === undefined || filter.value === '') {
          continue;
        }
        if (String(filter.id).startsWith('customFields.')) continue;
        if (filter.id === 'status' || filter.id === 'statusId') {
          const values = normalizeListFilter(filter.value);
          where.statusId =
            values.length > 1 ? ({ $in: values } as any) : values[0];
        } else if (filter.id === 'priority') {
          const values = normalizeListFilter(filter.value).map((value) =>
            value.toUpperCase(),
          );
          where.priority =
            values.length > 1 ? ({ $in: values } as any) : values[0];
        } else if (
          ['owner', 'assignedTo', 'createdBy', 'updatedBy'].includes(filter.id)
        ) {
          const field =
            (
              {
                owner: 'ownerId',
                assignedTo: 'assignedToId',
                createdBy: 'createdById',
                updatedBy: 'updatedById',
              } as Record<string, string>
            )[filter.id] ?? filter.id;
          where[field] = Array.isArray(filter.value)
            ? { $in: filter.value }
            : filter.value;
        }
      }
    }
    applyRegisteredCustomFieldFilters(
      where,
      filterOptions?.filters,
      filterOptions?.__customFieldDefinitions,
    );
    return where;
  }

  private buildExportFilter(params: { ids?: string[]; filters?: any }) {
    if (params.ids?.length) {
      return this.applyTenantFilter({
        _id: {
          $in: params.ids
            .filter((id) => Types.ObjectId.isValid(id))
            .map((id) => new Types.ObjectId(id)),
        },
        deletedAt: null,
      } as FilterQuery<TaskSchemaClass>);
    }
    return this.applyTenantFilter(
      this.buildSynchronousListWhere(params.filters),
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
    filterOptions?: any;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Task>> {
    // MED-08: Exclude soft-deleted tasks from list queries
    const where: FilterQuery<TaskSchemaClass> = {
      deletedAt: { $exists: false },
    };

    if (filterOptions?.search) {
      // MED-07: Escape user input to prevent ReDoS
      const searchExpr = {
        $regex: escapeRegex(filterOptions.search),
        $options: 'i',
      };
      where.$or = [{ title: searchExpr }, { description: searchExpr }];
    }

    const explicitStatusIds = normalizeListFilter(filterOptions?.statusIds);
    if (explicitStatusIds.length > 0) {
      where.statusId = { $in: explicitStatusIds } as any;
    } else if (filterOptions?.status) {
      // Status param can be comma-separated apiNames (e.g. 'pending,in_progress')
      const statusNames = String(filterOptions.status)
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);

      // Resolve apiNames to ObjectIds
      const statusDocs = await this.statusModel
        .find({ apiName: { $in: statusNames } })
        .select('_id')
        .lean()
        .exec();

      const statusIds = statusDocs.map((d: any) => d._id);
      if (statusIds.length > 0) {
        where.statusId =
          statusIds.length === 1 ? statusIds[0] : { $in: statusIds };
      } else {
        // No matching statuses found — return empty result
        where.statusId = { $in: [] };
      }
    }

    const priorities = normalizeListFilter(filterOptions?.priorities).map(
      (priority) => priority.toUpperCase(),
    );
    if (priorities.length > 0) {
      where.priority = { $in: priorities } as any;
    } else if (filterOptions?.priority) {
      where.priority = filterOptions.priority;
    }

    const dueFrom = filterOptions?.dueFrom
      ? new Date(String(filterOptions.dueFrom))
      : null;
    const dueTo = filterOptions?.dueTo
      ? new Date(String(filterOptions.dueTo))
      : null;
    if (
      (dueFrom && !Number.isNaN(dueFrom.getTime())) ||
      (dueTo && !Number.isNaN(dueTo.getTime()))
    ) {
      where.dueDate = {
        ...(dueFrom && !Number.isNaN(dueFrom.getTime())
          ? { $gte: dueFrom }
          : {}),
        ...(dueTo && !Number.isNaN(dueTo.getTime()) ? { $lte: dueTo } : {}),
      };
    }

    if (filterOptions?.contactId) {
      where.$and = [
        ...(where.$and || []),
        { 'relatedTo.type': 'Contact' },
        {
          $or: [
            { 'relatedTo._id': filterOptions.contactId },
            { 'relatedTo.id': filterOptions.contactId },
          ],
        },
      ];
    }

    applyRegisteredCustomFieldFilters(
      where,
      filterOptions?.filters,
      filterOptions?.__customFieldDefinitions,
    );

    const scopedWhere = this.applyTenantFilter(where);

    const [docs, totalItems] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ dueDate: 1, createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('assignedTo', 'firstName lastName photo email')
        .populate('owner', 'firstName lastName photo email')
        .populate('taskStatus')
        .populate('taskCategory')
        .populate('taskSource')
        .exec(),
      this.model.countDocuments(scopedWhere).exec(),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc)),
      totalItems,
      paginationOptions,
    );
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
      .populate('assignedTo', 'firstName lastName photo email')
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
