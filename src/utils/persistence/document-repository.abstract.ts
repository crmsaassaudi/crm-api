import { Injectable, ConflictException, Inject } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ClientSession,
  Model,
  Document,
  FilterQuery,
  UpdateQuery,
} from 'mongoose';

export abstract class BaseDocumentRepository<
  TSchema extends Document,
  TDomain,
> {
  constructor(
    protected readonly model: Model<TSchema>,
    protected readonly cls: ClsService,
  ) { }

  async create(
    data: Partial<TDomain>,
    session?: ClientSession,
  ): Promise<TDomain> {
    const created = new this.model(data);
    const saved = await created.save({ session });
    return this.mapToDomain(saved);
  }

  protected applyTenantFilter(filter: FilterQuery<TSchema> = {}): FilterQuery<TSchema> {
    const tenantId = this.cls.get('tenantId');
    if (tenantId) {
      return { ...filter, tenant: tenantId };
    }
    return filter;
  }

  async find(
    filter: FilterQuery<TSchema>,
    options?: any,
  ): Promise<TDomain[]> {
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

  async update(
    id: string,
    payload: Partial<TDomain>,
    session?: ClientSession,
  ): Promise<TDomain | null> {
    const clonedPayload = { ...payload };
    // @ts-ignore
    delete clonedPayload.id;

    const persistenceData: any = this.toPersistence(clonedPayload as TDomain);

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

  protected abstract mapToDomain(doc: TSchema): TDomain;

  protected abstract toPersistence(domain: TDomain): any;
}
