import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  OmniNoteSchemaClass,
  OmniNoteDocument,
} from '../infrastructure/persistence/document/entities/omni-note.schema';
import { PaginationResponseDto } from '../../utils/dto/pagination-response.dto';
import { pagination } from '../../utils/pagination';

export interface OmniNote {
  id: string;
  tenantId: string;
  conversationId: string;
  content: string;
  authorId: string;
  mentions: string[];
  isPrivate: boolean;
  /** True when this note is pinned as a Handover Note banner */
  isPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class NoteRepository {
  constructor(
    @InjectModel(OmniNoteSchemaClass.name)
    private readonly model: Model<OmniNoteDocument>,
  ) {}

  private toDomain(doc: OmniNoteSchemaClass): OmniNote {
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId?.toString(),
      conversationId: doc.conversationId?.toString(),
      content: doc.content,
      authorId: doc.authorId?.toString(),
      mentions: doc.mentions || [],
      isPrivate: doc.isPrivate ?? true,
      isPinned: doc.isPinned ?? false,
      createdAt: (doc as any).createdAt,
      updatedAt: (doc as any).updatedAt,
    };
  }

  async create(data: Partial<OmniNoteSchemaClass>): Promise<OmniNote> {
    const doc = await this.model.create(data);
    return this.toDomain(doc);
  }

  async findByConversation(
    conversationId: string,
    page: number,
    limit: number,
  ): Promise<PaginationResponseDto<OmniNote>> {
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * limit;

    const [items, total] = await Promise.all([
      this.model
        .find({ conversationId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.model.countDocuments({ conversationId }).exec(),
    ]);

    const mappedItems = items.map((doc) => this.toDomain(doc));
    return pagination(mappedItems, total, { page: safePage, limit });
  }

  async findById(id: string): Promise<OmniNote | null> {
    const doc = await this.model.findById(id).exec();
    return doc ? this.toDomain(doc) : null;
  }

  async update(
    id: string,
    data: Partial<OmniNoteSchemaClass>,
  ): Promise<OmniNote | null> {
    const doc = await this.model
      .findByIdAndUpdate(id, data, { new: true })
      .exec();
    return doc ? this.toDomain(doc) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.model.findByIdAndDelete(id).exec();
    return !!result;
  }

  async countByConversation(conversationId: string): Promise<number> {
    return this.model.countDocuments({ conversationId }).exec();
  }

  /**
   * Returns the most recent pinned (Handover) note for a conversation, or null.
   */
  async findPinnedByConversation(
    conversationId: string,
  ): Promise<OmniNote | null> {
    const doc = await this.model
      .findOne({ conversationId, isPinned: true })
      .sort({ createdAt: -1 })
      .exec();
    return doc ? this.toDomain(doc) : null;
  }

  /**
   * Unpin all previously pinned notes for a conversation, then pin the given note.
   * Ensures only one Handover Note is active at a time.
   */
  async setPinnedNote(conversationId: string, noteId: string): Promise<void> {
    await this.model
      .updateMany(
        { conversationId, isPinned: true },
        { $set: { isPinned: false } },
      )
      .exec();
    await this.model
      .findByIdAndUpdate(noteId, { $set: { isPinned: true } })
      .exec();
  }
}
