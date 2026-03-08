import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
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

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Ticket>> {
    const where: FilterQuery<TicketSchemaClass> = {};

    if (filterOptions?.search) {
      const searchExpr = { $regex: filterOptions.search, $options: 'i' };
      where.$or = [
        { subject: searchExpr },
        { ticketNumber: searchExpr },
        { description: searchExpr },
      ];
    }

    if (filterOptions?.status) {
      where.status = filterOptions.status;
    }

    if (filterOptions?.priority) {
      where.priority = filterOptions.priority;
    }

    const scopedWhere = this.applyTenantFilter(where);

    const [docs, totalItems] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('requester', 'firstName lastName photo email')
        .populate('assignee', 'firstName lastName photo email')
        .exec(),
      this.model.countDocuments(scopedWhere).exec(),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc)),
      totalItems,
      paginationOptions,
    );
  }

  async findOne(
    filter: FilterQuery<TicketSchemaClass>,
  ): Promise<Ticket | null> {
    const scopedFilter = this.applyTenantFilter(filter);
    const doc = await this.model
      .findOne(scopedFilter)
      .populate('requester', 'firstName lastName photo email')
      .populate('assignee', 'firstName lastName photo email')
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  async generateTicketNumber(): Promise<string> {
    const tenantId = this.cls.get('tenantId');
    const count = await this.model
      .countDocuments(tenantId ? { tenant: tenantId } : {})
      .exec();
    return `TKT-${(count + 1).toString().padStart(5, '0')}`;
  }
}
