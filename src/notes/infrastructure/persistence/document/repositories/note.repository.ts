import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { Note } from '../../../../domain/note';
import { NoteSchemaClass, NoteSchemaDocument } from '../entities/note.schema';
import { NoteMapper } from '../mappers/note.mapper';

@Injectable()
export class NoteRepository extends BaseDocumentRepository<
  NoteSchemaDocument,
  Note
> {
  constructor(
    @InjectModel(NoteSchemaClass.name)
    model: Model<NoteSchemaDocument>,
    cls: ClsService,
  ) {
    super(model, cls);
  }

  protected enableDataVisibility(): boolean {
    return false;
  }

  protected mapToDomain(doc: NoteSchemaClass): Note {
    return NoteMapper.toDomain(doc);
  }

  protected toPersistence(domain: Note): NoteSchemaClass {
    return NoteMapper.toPersistence(domain);
  }

  async findByContact(params: {
    contactId: string;
    limit: number;
    cursor?: string;
  }): Promise<{
    data: Note[];
    nextCursor: string | null;
    hasNextPage: boolean;
  }> {
    const where: FilterQuery<NoteSchemaClass> = {
      contactId: params.contactId,
      deletedAt: { $exists: false },
    };

    if (params.cursor) {
      const cursorDate = new Date(params.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        where.createdAt = { $lt: cursorDate };
      }
    }

    const scopedWhere = this.applyTenantFilter(where);
    const docs = await this.model
      .find(scopedWhere)
      .sort({ createdAt: -1, _id: -1 })
      .limit(params.limit + 1)
      .exec();

    const pageDocs = docs.slice(0, params.limit);

    return {
      data: pageDocs.map((doc) => this.mapToDomain(doc)),
      nextCursor:
        docs.length > params.limit && pageDocs.length > 0
          ? pageDocs[pageDocs.length - 1].createdAt.toISOString()
          : null,
      hasNextPage: docs.length > params.limit,
    };
  }

  async softDelete(id: string): Promise<void> {
    const scopedFilter = this.applyTenantFilter({ _id: id });
    await this.model.updateOne(scopedFilter, { deletedAt: new Date() }).exec();
  }
}
