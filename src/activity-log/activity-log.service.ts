import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ActivityLog } from './domain/activity-log';
import { ActivityLogRepository } from './infrastructure/persistence/document/repositories/activity-log.repository';

export type ActivityFeedType =
  | 'note'
  | 'email'
  | 'call'
  | 'task'
  | 'meeting'
  | 'merge';

@Injectable()
export class ActivityLogService {
  constructor(
    private readonly repository: ActivityLogRepository,
    private readonly cls: ClsService,
  ) {}

  async create(data: {
    targetType: string;
    targetId: string;
    event: string;
    actorId?: string;
    payload?: Record<string, any>;
    occurredAt?: Date;
  }): Promise<ActivityLog> {
    return this.repository.create({
      targetType: data.targetType,
      targetId: data.targetId,
      event: data.event,
      actorId:
        data.actorId ?? this.cls.get('userId') ?? this.cls.get('user.id'),
      payload: data.payload,
      occurredAt: data.occurredAt ?? new Date(),
    } as ActivityLog);
  }

  async getFeed(params: {
    targetType: string;
    targetId: string;
    type?: ActivityFeedType;
    limit?: number;
    cursor?: string;
  }) {
    const result = await this.repository.findByTarget({
      targetType: params.targetType,
      targetId: params.targetId,
      event: params.type,
      limit: Math.min(Math.max(Number(params.limit) || 20, 1), 100),
      cursor: params.cursor,
    });

    return {
      data: result.data.map((item) => ({
        id: item.id,
        type: item.event,
        actorId: item.actorId,
        actor: item.actor,
        occurredAt: item.occurredAt,
        payload: item.payload ?? {},
      })),
      nextCursor: result.nextCursor,
      hasNextPage: result.hasNextPage,
    };
  }
}
