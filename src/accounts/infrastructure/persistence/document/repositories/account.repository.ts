import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import {
  AccountSchemaClass,
  AccountSchemaDocument,
} from '../entities/account.schema';
import { Account } from '../../../../domain/account';
import { AccountMapper } from '../mappers/account.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';

@Injectable()
export class AccountRepository extends BaseDocumentRepository<
  AccountSchemaDocument,
  Account
> {
  constructor(
    @InjectModel(AccountSchemaClass.name)
    accountModel: Model<AccountSchemaDocument>,
    cls: ClsService,
  ) {
    super(accountModel, cls);
  }

  protected mapToDomain(doc: AccountSchemaClass): Account {
    return AccountMapper.toDomain(doc);
  }

  protected toPersistence(domain: Account): AccountSchemaClass {
    return AccountMapper.toPersistence(domain);
  }

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Account>> {
    const where: FilterQuery<AccountSchemaClass> = {};

    if (filterOptions?.search) {
      const searchExpr = { $regex: filterOptions.search, $options: 'i' };
      where.$or = [
        { name: searchExpr },
        { industry: searchExpr },
        { phones: searchExpr },
        { emails: searchExpr },
      ];
    }

    const scopedWhere = this.applyTenantFilter(where);

    const [docs, totalItems] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('owner')
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
    filter: FilterQuery<AccountSchemaClass>,
  ): Promise<Account | null> {
    const scopedFilter = this.applyTenantFilter(filter);
    const doc = await this.model.findOne(scopedFilter).populate('owner').exec();
    return doc ? this.mapToDomain(doc) : null;
  }
}
