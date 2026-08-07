import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, FilterQuery, Types } from 'mongoose';
import { BusinessException } from '../../../../../common/exceptions/business.exception';
import { TICKET_ERRORS } from '../../../../constants/ticket-error-codes';
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../entities/ticket.schema';
import { Ticket } from '../../../../domain/ticket';
import { TicketMapper } from '../mappers/ticket.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { VisibilityModule } from '../../../../../common/permissions/visibility-modules';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';
import { applySearchKeys } from '../../../../../common/search/search-keys.query';
import { cappedCount } from '../../../../../utils/capped-count';
import { applyRegisteredCustomFieldFilters } from '../../../../../utils/custom-field-filter';
import { normalizeTicketNumberQuery } from '../../../../search/ticket-number-query';
import { SORTABLE_FIELDS } from '../../../../../object-manager/sortable-fields';

const TICKET_SORTABLE = new Set<string>(SORTABLE_FIELDS.Ticket);

const resolveTicketSort = (filterOptions?: {
  sortBy?: string;
  sortOrder?: string;
}): Record<string, 1 | -1> => {
  const field =
    filterOptions?.sortBy && TICKET_SORTABLE.has(filterOptions.sortBy)
      ? filterOptions.sortBy
      : 'createdAt';
  const direction: 1 | -1 = filterOptions?.sortOrder === 'asc' ? 1 : -1;
  return { [field]: direction, _id: direction };
};

const normalizeListFilter = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return values
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .slice(0, 100);
};

@Injectable()
export class TicketRepository extends BaseDocumentRepository<
  TicketSchemaDocument,
  Ticket
> {
  constructor(
    @InjectModel(TicketSchemaClass.name)
    ticketModel: Model<TicketSchemaDocument>,
    cls: ClsService,
  ) {
    super(ticketModel, cls);
  }

  /** Tagged so a tenant can scope tickets differently from other modules. */
  protected visibilityModule(): VisibilityModule {
    return 'Ticket';
  }

  protected mapToDomain(doc: TicketSchemaClass): Ticket {
    return TicketMapper.toDomain(doc);
  }

  protected toPersistence(domain: Ticket): TicketSchemaClass {
    return TicketMapper.toPersistence(domain);
  }

  private buildListWhere(filterOptions?: any): FilterQuery<TicketSchemaClass> {
    const where: FilterQuery<TicketSchemaClass> = { deletedAt: null };
    if (filterOptions?.search) {
      const ticketNumber = normalizeTicketNumberQuery(filterOptions.search);
      if (ticketNumber) {
        where.ticketNumber = ticketNumber;
      } else {
        applySearchKeys(where as Record<string, any>, filterOptions.search);
      }
    }
    const statusIds = normalizeListFilter(filterOptions?.statusIds);
    if (statusIds.length) where.statusId = { $in: statusIds } as any;
    else if (filterOptions?.statusId) where.statusId = filterOptions.statusId;

    const priorities = normalizeListFilter(filterOptions?.priorities).map(
      (priority) => priority.toUpperCase(),
    );
    if (priorities.length) where.priority = { $in: priorities } as any;
    else if (filterOptions?.priority) where.priority = filterOptions.priority;

    for (const field of [
      'typeId',
      'groupId',
      'contactId',
      'dealId',
      'parentTicketId',
    ] as const) {
      if (filterOptions?.[field]) where[field] = filterOptions[field];
    }
    if (filterOptions?.categoryPath) {
      where.categoryPath = { $in: [filterOptions.categoryPath] } as any;
    }

    // Table filters use singular UI keys while list query DTOs also support
    // plural top-level keys. Normalize both into the same repository query.
    const tableFilters =
      typeof filterOptions?.filters === 'string'
        ? (() => {
            try {
              return JSON.parse(filterOptions.filters);
            } catch {
              return [];
            }
          })()
        : filterOptions?.filters;
    if (Array.isArray(tableFilters)) {
      for (const filter of tableFilters) {
        if (!filter?.id || filter.value === undefined || filter.value === '') {
          continue;
        }
        if (String(filter.id).startsWith('customFields.')) continue;
        if (filter.id === 'status') {
          const values = normalizeListFilter(filter.value).filter((value) =>
            Types.ObjectId.isValid(value),
          );
          if (values.length > 0) where.statusId = { $in: values } as any;
        } else if (filter.id === 'priority') {
          const values = normalizeListFilter(filter.value).map((value) =>
            value.toUpperCase(),
          );
          where.priority =
            values.length > 1 ? ({ $in: values } as any) : values[0];
        } else if (['owner', 'createdBy', 'updatedBy'].includes(filter.id)) {
          const field =
            (
              {
                owner: 'ownerId',
                createdBy: 'createdById',
                updatedBy: 'updatedById',
              } as Record<string, string>
            )[filter.id] ?? filter.id;
          const values = normalizeListFilter(filter.value).filter((value) =>
            Types.ObjectId.isValid(value),
          );
          if (values.length > 0) where[field] = { $in: values };
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

  private buildExportFilter(params: {
    ids?: string[];
    filters?: any;
  }): FilterQuery<TicketSchemaClass> {
    if (!params.ids?.length) {
      return this.applyTenantFilter(this.buildListWhere(params.filters));
    }
    return this.applyTenantFilter({
      _id: {
        $in: params.ids
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id)),
      },
      deletedAt: null,
    } as FilterQuery<TicketSchemaClass>);
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
      .sort({ createdAt: -1 })
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

  private populateRefs(query: any) {
    return query
      .populate('contact', 'firstName lastName emails phones photo')
      .populate('account', 'name')
      .populate('owner', 'firstName lastName photo email')
      .populate('group', 'name')
      .populate(
        'ticketStatus',
        'label apiName color sortOrder isDefault isTerminal',
      )
      .populate('ticketType', 'name apiName description color')
      .populate('ticketSource', 'name')
      .populate('ticketResolution', 'name apiName');
  }

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Ticket>> {
    const where = this.buildListWhere(filterOptions);
    const scopedWhere = this.applyTenantFilter(where);

    // .lean() skips Mongoose hydration which roughly halves RAM/CPU on large
    // pages with 7+ populated refs. Mapper accepts plain objects.
    const [docs, { totalItems }] = await Promise.all([
      this.populateRefs(
        this.model
          .find(scopedWhere)
          .sort(resolveTicketSort(filterOptions))
          .skip((paginationOptions.page - 1) * paginationOptions.limit)
          .limit(paginationOptions.limit)
          .lean(),
      ).exec(),
      cappedCount(this.model as any, scopedWhere),
    ]);

    return pagination(
      docs.map((doc: any) => this.mapToDomain(doc)),
      totalItems,
      paginationOptions,
    );
  }

  async findOne(
    filter: FilterQuery<TicketSchemaClass>,
  ): Promise<Ticket | null> {
    const scopedFilter = this.applyTenantFilter(
      filter.deletedAt !== undefined ? filter : { ...filter, deletedAt: null },
    );
    const doc = await this.populateRefs(
      this.model.findOne(scopedFilter),
    ).exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  async updateWithVersion(
    id: string,
    payload: Record<string, any>,
    version: number | undefined,
    session?: ClientSession,
  ): Promise<Ticket> {
    if (version === undefined) {
      return this.update(id, payload as any, session);
    }

    const current = await this.model
      .findOne(this.applyTenantFilter({ _id: id, deletedAt: null }))
      .select({ __v: 1 })
      .lean()
      .exec();
    if (!current) {
      throw new NotFoundException(`Ticket ${id} not found`);
    }
    if ((current as any).__v !== version) {
      throw new BusinessException(
        TICKET_ERRORS.VERSION_CONFLICT,
        HttpStatus.CONFLICT,
        'This ticket was changed by someone else while you were editing it. Reload to see the latest version.',
      );
    }
    return this.update(id, { ...payload, __v: version } as any, session);
  }

  async addTagsToTickets(
    ticketIds: string[],
    tags: string[],
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const scopedFilter = this.applyTenantFilter({
      _id: { $in: ticketIds },
      deletedAt: null,
    } as FilterQuery<TicketSchemaClass>);
    const updatedById = this.cls.get('userId') ?? this.cls.get('user.id');
    const result = await this.model
      .updateMany(scopedFilter, {
        $addToSet: { tags: { $each: tags } },
        $set: {
          updatedAt: new Date(),
          ...(updatedById ? { updatedById } : {}),
        },
        $inc: { __v: 1 },
      })
      .exec();

    return {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
    };
  }

  async findManyByIds(ids: string[]): Promise<Ticket[]> {
    const docs = await this.model
      .find(
        this.applyTenantFilter({
          _id: { $in: ids },
          deletedAt: null,
        } as FilterQuery<TicketSchemaClass>),
      )
      .lean()
      .exec();
    return docs.map((doc: any) => this.mapToDomain(doc));
  }

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

  /** Hard-delete one ticket. Only TicketPurgeService may call this. */
  async hardDelete(id: string): Promise<void> {
    await this.model
      .deleteOne({ _id: id })
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
  }

  async softDeleteInSession(id: string, session: ClientSession): Promise<void> {
    const updatedById = this.cls.get('userId') ?? this.cls.get('user.id');
    const result = await this.model
      .updateOne(
        this.applyTenantFilter({ _id: id, deletedAt: null }),
        {
          $set: {
            deletedAt: new Date(),
            ...(updatedById ? { updatedById } : {}),
          },
        },
        { session },
      )
      .exec();
    if (result.matchedCount === 0) {
      throw new Error(`Ticket ${id} could not be deleted during merge`);
    }
  }

  /** Load only the parent pointer, avoiding the expensive list/detail populates. */
  async findParentId(id: string): Promise<string | null | undefined> {
    const doc = await this.model
      .findOne(this.applyTenantFilter({ _id: id, deletedAt: null }))
      .select({ parentTicketId: 1 })
      .lean()
      .exec();
    if (!doc) return undefined;
    return (doc as any).parentTicketId
      ? String((doc as any).parentTicketId)
      : null;
  }

  async pauseSlaAtomic(id: string, now: Date): Promise<Ticket | null> {
    const actorId = this.cls.get('userId') ?? this.cls.get('user.id');
    const doc = await this.model
      .findOneAndUpdate(
        this.applyTenantFilter({
          _id: id,
          deletedAt: null,
          $or: [{ slaPausedAt: null }, { slaResumedAt: { $ne: null } }],
        }),
        {
          $set: {
            slaPausedAt: now,
            updatedAt: now,
            ...(actorId ? { updatedById: actorId } : {}),
          },
          $unset: { slaResumedAt: '' },
        },
        { new: true },
      )
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  async resumeSlaAtomic(id: string, now: Date): Promise<Ticket | null> {
    const actorId = this.cls.get('userId') ?? this.cls.get('user.id');
    const persistedActorId =
      actorId && Types.ObjectId.isValid(String(actorId))
        ? new Types.ObjectId(String(actorId))
        : actorId;
    const filter = this.applyTenantFilter({
      _id: id,
      deletedAt: null,
      slaPausedAt: { $ne: null },
      slaResumedAt: null,
    });
    const doc = await this.model
      .findOneAndUpdate(
        filter,
        [
          {
            $set: {
              slaResumedAt: now,
              updatedAt: now,
              ...(persistedActorId ? { updatedById: persistedActorId } : {}),
              slaPausedSeconds: {
                $add: [
                  { $ifNull: ['$slaPausedSeconds', 0] },
                  {
                    $floor: {
                      $divide: [{ $subtract: [now, '$slaPausedAt'] }, 1000],
                    },
                  },
                ],
              },
              firstResponseDueAt: {
                $cond: [
                  { $ne: [{ $ifNull: ['$firstResponseDueAt', null] }, null] },
                  {
                    $add: [
                      '$firstResponseDueAt',
                      { $subtract: [now, '$slaPausedAt'] },
                    ],
                  },
                  '$firstResponseDueAt',
                ],
              },
              resolutionDueAt: {
                $cond: [
                  { $ne: [{ $ifNull: ['$resolutionDueAt', null] }, null] },
                  {
                    $add: [
                      '$resolutionDueAt',
                      { $subtract: [now, '$slaPausedAt'] },
                    ],
                  },
                  '$resolutionDueAt',
                ],
              },
            },
          },
        ],
        { new: true },
      )
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }
}
