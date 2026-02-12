import {
  Injectable,
  ConflictException,
  Inject,
} from '@nestjs/common';
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

  constructor(protected readonly model: Model<TSchema>) { }

  // Luôn cho phép nhận session ở tham số cuối cùng
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

    const persistenceData: any = this.toPersistence(payload as TDomain);

    const version = persistenceData.__v;
    delete persistenceData.__v;

    const filter: any = { _id: id };
    if (tenantId) {
      filter.tenantId = tenantId;
    }

    if (version !== undefined) {
      filter.__v = version;
    }

    const updated = await this.model
      .findOneAndUpdate(
        filter,
        {
          ...persistenceData,
          $inc: { __v: 1 },
        },
        { new: true, session },
      ) as TSchema;

    if (!updated && version !== undefined) {
      throw new ConflictException('Data has been modified. Please reload.');
    }

    return updated ? this.mapToDomain(updated) : null;
  }

  protected abstract mapToDomain(doc: TSchema): TDomain;

  protected abstract toPersistence(domain: TDomain): any;
}
