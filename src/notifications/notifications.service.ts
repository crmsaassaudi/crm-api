import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  NotificationDocument,
  NotificationSchemaClass,
  NotificationType,
} from './infrastructure/persistence/document/entities/notification.schema';
import { Notification } from './domain/notification';

export interface CreateNotificationInput {
  tenantId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: { type: string; id: string } | null;
}

const LIST_MAX_LIMIT = 50;
const LIST_DEFAULT_LIMIT = 20;

/**
 * The persisted half of every notification `CrmRealtimeGateway` broadcasts to
 * one named user. The live socket emit reaches whoever is connected right
 * now; this is what an offline recipient sees on their next visit instead of
 * nothing, which — before this module existed — was the platform's only
 * outcome for a missed notification.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(NotificationSchemaClass.name)
    private readonly model: Model<NotificationDocument>,
    private readonly cls: ClsService,
  ) {}

  /**
   * Called from `CrmRealtimeGateway`'s Redis-message handlers — outside any
   * HTTP request, so `tenantId`/`userId` are the caller's own explicit values,
   * not CLS. Never throws: a persistence failure must not take down the live
   * broadcast it accompanies.
   */
  async create(input: CreateNotificationInput): Promise<void> {
    try {
      await this.model.create({
        tenantId: input.tenantId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist ${input.type} notification for user=${input.userId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async listForCaller(options: {
    page?: number;
    limit?: number;
    unreadOnly?: boolean;
  }): Promise<{
    data: Notification[];
    totalItems: number;
    page: number;
    limit: number;
  }> {
    const userId = this.requireUserId();
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(options.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
    const where: Record<string, unknown> = { userId };
    if (options.unreadOnly) where.readAt = null;

    const [docs, totalItems] = await Promise.all([
      this.model
        .find(where)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.model.countDocuments(where).exec(),
    ]);

    return {
      data: docs.map((doc) => this.toDomain(doc)),
      totalItems,
      page,
      limit,
    };
  }

  async unreadCountForCaller(): Promise<number> {
    const userId = this.requireUserId();
    return this.model.countDocuments({ userId, readAt: null }).exec();
  }

  /** Ownership is enforced here, not trusted from the caller: `id` alone must never be enough to mark someone else's notification read. */
  async markRead(id: string): Promise<void> {
    const userId = this.requireUserId();
    const result = await this.model
      .updateOne({ _id: id, userId, readAt: null }, { $set: { readAt: new Date() } })
      .exec();
    if (result.matchedCount === 0) {
      const exists = await this.model.exists({ _id: id, userId });
      if (!exists) throw new NotFoundException('Notification not found');
      // Matched zero because it was already read — idempotent, not an error.
    }
  }

  async markAllRead(): Promise<{ updated: number }> {
    const userId = this.requireUserId();
    const result = await this.model
      .updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } })
      .exec();
    return { updated: result.modifiedCount };
  }

  private requireUserId(): string {
    const userId = this.cls.get<string>('userId');
    if (!userId) throw new NotFoundException('Not authenticated');
    return userId;
  }

  private toDomain(doc: any): Notification {
    return {
      id: String(doc._id),
      type: doc.type,
      title: doc.title,
      body: doc.body,
      link: doc.link ?? null,
      readAt: doc.readAt ?? null,
      createdAt: doc.createdAt,
    };
  }
}
