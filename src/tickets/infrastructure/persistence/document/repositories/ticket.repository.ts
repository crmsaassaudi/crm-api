import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types } from 'mongoose';
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../entities/ticket.schema';
import { Ticket } from '../../../../domain/ticket';
import { TicketMapper } from '../mappers/ticket.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';
import { escapeRegex } from '../../../../../utils/escape-regex';
import { cappedCount } from '../../../../../utils/capped-count';

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

  protected mapToDomain(doc: TicketSchemaClass): Ticket {
    return TicketMapper.toDomain(doc);
  }

  protected toPersistence(domain: Ticket): TicketSchemaClass {
    return TicketMapper.toPersistence(domain);
  }

  // ─────────────────────────── EXPORT ───────────────────────────

  private buildExportFilter(params: {
    ids?: string[];
  }): FilterQuery<TicketSchemaClass> {
    const base: FilterQuery<TicketSchemaClass> =
      params.ids && params.ids.length > 0
        ? {
            _id: {
              $in: params.ids
                .filter((id) => Types.ObjectId.isValid(id))
                .map((id) => new Types.ObjectId(id)),
            },
          }
        : {};
    return this.applyTenantFilter({
      ...base,
      deletedAt: { $exists: false },
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
    const where: FilterQuery<TicketSchemaClass> = {};

    if (filterOptions?.search) {
      const searchExpr = {
        $regex: escapeRegex(filterOptions.search),
        $options: 'i',
      };
      where.$or = [
        { subject: searchExpr },
        { ticketNumber: searchExpr },
        { description: searchExpr },
      ];
    }

    if (filterOptions?.statusId) {
      where.statusId = filterOptions.statusId;
    }

    if (filterOptions?.priority) {
      where.priority = filterOptions.priority;
    }

    if (filterOptions?.typeId) {
      where.typeId = filterOptions.typeId;
    }

    if (filterOptions?.categoryPath) {
      where.categoryPath = { $in: [filterOptions.categoryPath] } as any;
    }

    if (filterOptions?.groupId) {
      where.groupId = filterOptions.groupId;
    }

    if (filterOptions?.contactId) {
      where.contactId = filterOptions.contactId;
    }

    const scopedWhere = this.applyTenantFilter(where);

    // .lean() skips Mongoose hydration which roughly halves RAM/CPU on large
    // pages with 7+ populated refs. Mapper accepts plain objects.
    const [docs, { totalItems }] = await Promise.all([
      this.populateRefs(
        this.model
          .find(scopedWhere)
          .sort({ createdAt: -1 })
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
    const scopedFilter = this.applyTenantFilter(filter);
    const doc = await this.populateRefs(
      this.model.findOne(scopedFilter),
    ).exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  async generateTicketNumber(): Promise<string> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new Error('Tenant context is required to generate ticket number');
    }

    // Use an atomic counter via findOneAndUpdate to prevent race conditions.
    // The counters collection stores per-tenant sequence numbers.
    const counterResult = await this.model.db
      .collection('counters')
      .findOneAndUpdate(
        { _id: `ticket_seq:${tenantId}` } as any,
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      );

    const seq = (counterResult as any)?.seq ?? 1;
    return `TKT-${seq.toString().padStart(5, '0')}`;
  }

  async addTagsToTickets(
    ticketIds: string[],
    tags: string[],
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const scopedFilter = this.applyTenantFilter({
      _id: { $in: ticketIds },
      deletedAt: { $exists: false },
    } as FilterQuery<TicketSchemaClass>);
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
}
