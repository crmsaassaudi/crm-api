import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { ActivityLog } from '../../../../domain/activity-log';
import {
  ActivityLogSchemaClass,
  ActivityLogSchemaDocument,
} from '../entities/activity-log.schema';
import { ActivityLogMapper } from '../mappers/activity-log.mapper';

@Injectable()
export class ActivityLogRepository extends BaseDocumentRepository<
  ActivityLogSchemaDocument,
  ActivityLog
> {
  constructor(
    @InjectModel(ActivityLogSchemaClass.name)
    model: Model<ActivityLogSchemaDocument>,
    cls: ClsService,
  ) {
    super(model, cls);
  }

  protected enableDataVisibility(): boolean {
    return false;
  }

  protected mapToDomain(doc: ActivityLogSchemaClass): ActivityLog {
    return ActivityLogMapper.toDomain(doc);
  }

  protected toPersistence(domain: ActivityLog): ActivityLogSchemaClass {
    return ActivityLogMapper.toPersistence(domain);
  }

  async findByTarget(params: {
    targetType: string;
    targetId: string;
    event?: string;
    limit: number;
    cursor?: string;
  }): Promise<{
    data: ActivityLog[];
    nextCursor: string | null;
    hasNextPage: boolean;
  }> {
    const where: FilterQuery<ActivityLogSchemaClass> = {
      targetType: params.targetType,
      targetId: params.targetId,
      // Exclude legacy system events that were incorrectly stored as activities.
      // These records remain in DB for historical reference but are filtered from UI.
      event: {
        $nin: [
          'stage_change',
          'deleted',
          'fields_unmasked',
          'bulk_tagged',
          'export_downloaded',
          'export',
        ],
      },
    };

    if (params.event) {
      where.event = params.event;
    }

    if (params.cursor) {
      const cursorDate = new Date(params.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        where.occurredAt = { $lt: cursorDate };
      }
    }

    const scopedWhere = this.applyTenantFilter(where);
    const docs = await this.model
      .find(scopedWhere)
      .populate({
        path: 'actor',
        select: 'firstName lastName email photo',
      })
      .sort({ occurredAt: -1, _id: -1 })
      .limit(params.limit + 1)
      .exec();

    const pageDocs = docs.slice(0, params.limit);

    return {
      data: pageDocs.map((doc) => this.mapToDomain(doc)),
      nextCursor:
        docs.length > params.limit && pageDocs.length > 0
          ? pageDocs[pageDocs.length - 1].occurredAt.toISOString()
          : null,
      hasNextPage: docs.length > params.limit,
    };
  }
}
