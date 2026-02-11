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
  constructor(protected readonly model: Model<TSchema>) {}

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
    payload: UpdateQuery<TSchema>,
    session?: ClientSession,
  ): Promise<TDomain | null> {
    const updated = await this.model
      .findByIdAndUpdate(id, payload, { new: true })
      .session(session || null);
    return updated ? this.mapToDomain(updated) : null;
  }

  protected abstract mapToDomain(doc: TSchema): TDomain;
}
