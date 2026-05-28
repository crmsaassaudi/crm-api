import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
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
  authorName?: string;
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
    private readonly cls: ClsService,
  ) {}

  private getTenantId(): string {
    const tenantId =
      this.cls.get<string>('activeTenantId') || this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new Error(
        'NoteRepository: missing tenant context — refusing to query',
      );
    }
    return tenantId;
  }

  private toDomain(doc: OmniNoteSchemaClass): OmniNote {
    let authorName: string | undefined;

    if (doc.authorId && typeof doc.authorId === 'object') {
      const u = doc.authorId as any;
      const fullName = [u.firstName, u.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      authorName = fullName || u.email || 'Agent';
      if (fullName && u.email) authorName = `${fullName} (${u.email})`;
    }

    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId?.toString(),
      conversationId: doc.conversationId?.toString(),
      content: doc.content,
      authorId:
        typeof doc.authorId === 'object'
          ? (doc.authorId as any)._id?.toString()
          : doc.authorId?.toString(),
      authorName,
      mentions: doc.mentions || [],
      isPrivate: doc.isPrivate ?? true,
      isPinned: doc.isPinned ?? false,
      createdAt: (doc as any).createdAt,
      updatedAt: (doc as any).updatedAt,
    };
  }

  async create(data: Partial<OmniNoteSchemaClass>): Promise<OmniNote> {
    const doc = await this.model.create(data);
    // Re-fetch with populate to get author name immediately
    const populated = await this.model
      .findById(doc._id)
      .populate('authorId', 'firstName lastName email')
      .exec();
    return this.toDomain(populated || doc);
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
        .populate('authorId', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.model.countDocuments({ conversationId }).exec(),
    ]);

    const mappedItems = items.map((doc) => this.toDomain(doc as any));
    return pagination(mappedItems, total, { page: safePage, limit });
  }

  async findById(id: string): Promise<OmniNote | null> {
    const doc = await this.model
      .findById(id)
      .populate('authorId', 'firstName lastName email')
      .exec();
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
      .populate('authorId', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .exec();
    return doc ? this.toDomain(doc) : null;
  }

  /**
   * Unpin all previously pinned notes for a conversation, then pin the given note.
   * Ensures only one Handover Note is active at a time.
   *
   * Defence-in-depth: explicit tenantId filter in addition to tenantFilterPlugin.
   * Uses bulkWrite so the unpin + pin pair runs in a single round trip.
   */
  async setPinnedNote(conversationId: string, noteId: string): Promise<void> {
    const tenantId = this.getTenantId();
    await this.model.bulkWrite([
      {
        updateMany: {
          filter: { tenantId, conversationId, isPinned: true },
          update: { $set: { isPinned: false } },
        },
      },
      {
        updateOne: {
          filter: { _id: noteId, tenantId, conversationId },
          update: { $set: { isPinned: true } },
        },
      },
    ]);
  }
}
