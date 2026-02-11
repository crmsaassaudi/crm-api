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
    payload: UpdateQuery<TSchema>,
    session?: ClientSession,
  ): Promise<TDomain | null> {
    const filter = { _id: id };
    // Note: We might want to pass 'version' here if we want to enforce it via query
    // But BaseRepository signature changes might strict.
    // If payload contains version checks, findOneAndUpdate handles it.

    // However, to support generic version error handling with 'save()':
    // 1. Fetch document
    // 2. Update properties
    // 3. Save (Mongoose checks __v)

    // But 'payload' here is UpdateQuery (like $set), which works with findOneAndUpdate.
    // Transitioning to 'save()' requires payload to be Partial<TSchema> or similar, not Update Operators.
    // Given the Senior Lead said: "Sửa lại hàm update ... để bắt lỗi VersionError ... throw ra ConflictException"
    // And also: "Update `UserRepository` update method to accept `version`" (which we did in specific repo).

    // Let's implement the generic handle via findOneAndUpdate for now as it supports atomic operators better,
    // OR we change this to save() but that breaks $inc, $push usage.

    // If we want to support VersionError from Mongoose, we usually use save().
    // If we use findOneAndUpdate, we must manually check result as we did in UserRepo.

    const updated = await this.model
      .findByIdAndUpdate(id, payload, { new: true })
      .session(session || null);

    // If we want to enforce version check here genericly, we need 'version' passed in.
    // But the signature is fixed in the abstract class unless we change it.

    return updated ? this.mapToDomain(updated) : null;
  }

  protected abstract mapToDomain(doc: TSchema): TDomain;
}
