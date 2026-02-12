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
  @Inject(ClsService)
  protected readonly cls: ClsService;

  constructor(protected readonly model: Model<TSchema>) {}

  async create(
    data: Partial<TDomain>,
    session?: ClientSession,
  ): Promise<TDomain> {
    const created = new this.model(data);
    const saved = await created.save({ session });
    return this.mapToDomain(saved);
  }

  async findOne(
    filter: FilterQuery<TSchema>,
    session?: ClientSession,
  ): Promise<TDomain | null> {
    const doc = await this.model.findOne(filter).session(session || null);
    return doc ? this.mapToDomain(doc) : null;
  }

  async update(
    id: string,
    payload: Partial<TDomain>,
    session?: ClientSession,
  ): Promise<TDomain | null> {
    const tenantId = this.cls.get('tenantId');

    // 1. Convert Domain Entity to Persistence
    const persistenceData: any = this.toPersistence(payload as TDomain);

    // 2. Extract version for Optimistic Lock
    const version = persistenceData.__v;
    delete persistenceData.__v; // Remove from payload to avoid overwriting

    const filter: any = { _id: id };
    if (tenantId) {
      filter.tenantId = tenantId;
    }

    // 3. If version is present, add to query filter
    if (version !== undefined) {
      filter.__v = version;
    }

    const updated = (await this.model.findOneAndUpdate(
      filter,
      {
        ...persistenceData,
        $inc: { __v: 1 }, // Auto-increment version
      },
      { new: true, session: session || null },
    )) as TSchema;

    // 4. Check result: If update failed but version was provided -> CONFLICT
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
    await this.model.deleteOne({ _id: id });
  }

  protected abstract mapToDomain(doc: TSchema): TDomain;

  protected abstract toPersistence(domain: TDomain): any;
}
