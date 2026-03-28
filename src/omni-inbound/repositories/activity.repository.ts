import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ConversationActivitySchemaClass,
  ConversationActivityDocument,
} from '../infrastructure/persistence/document/entities/conversation-activity.schema';
import { PaginationResponseDto } from '../../utils/dto/pagination-response.dto';
import { pagination } from '../../utils/pagination';

export interface ConversationActivity {
  id: string;
  tenantId: string;
  conversationId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  metadata: Record<string, any>;
  createdAt: Date;
}

@Injectable()
export class ActivityRepository {
  constructor(
    @InjectModel(ConversationActivitySchemaClass.name)
    private readonly model: Model<ConversationActivityDocument>,
  ) {}

  private toDomain(doc: ConversationActivitySchemaClass): ConversationActivity {
    return {
      id: doc._id.toString(),
      tenantId: doc.tenant?.toString(),
      conversationId: doc.conversationId?.toString(),
      actorType: doc.actorType,
      actorId: doc.actorId?.toString() ?? null,
      action: doc.action,
      oldValue: doc.oldValue,
      newValue: doc.newValue,
      metadata: doc.metadata || {},
      createdAt: (doc as any).createdAt,
    };
  }

  async create(data: Partial<ConversationActivitySchemaClass>): Promise<ConversationActivity> {
    const doc = await this.model.create(data);
    return this.toDomain(doc);
  }

  async findByConversation(
    conversationId: string,
    page: number,
    limit: number,
  ): Promise<PaginationResponseDto<ConversationActivity>> {
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
}
