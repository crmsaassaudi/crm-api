import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, SortOrder } from 'mongoose';
import {
  AiVideoJobSchemaClass,
  AiVideoJobSchemaDocument,
} from '../infrastructure/persistence/document/entities/ai-video-job.schema';
import { AiVideoJob } from '../domain/ai-video-job';
import { AiVideoJobMapper } from '../infrastructure/persistence/document/mappers/ai-video-job.mapper';

export interface AiVideoJobQuery {
  tenantId: string;
  status?: string | string[];
  facebookPageId?: string;
}

@Injectable()
export class AiVideoJobRepository {
  constructor(
    @InjectModel(AiVideoJobSchemaClass.name)
    private readonly model: Model<AiVideoJobSchemaDocument>,
  ) {}

  async create(data: Partial<AiVideoJobSchemaClass>): Promise<AiVideoJob> {
    const doc = await this.model.create(data);
    return AiVideoJobMapper.toDomain(doc);
  }

  async findById(tenantId: string, id: string): Promise<AiVideoJob | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? AiVideoJobMapper.toDomain(doc) : null;
  }

  async findPaginated(
    query: AiVideoJobQuery,
    page: number,
    limit: number,
  ): Promise<{ items: AiVideoJob[]; total: number }> {
    const filter = this.buildFilter(query);
    const sort: Record<string, SortOrder> = { createdAt: -1 };
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * limit;

    const [docs, total] = await Promise.all([
      this.model.find(filter).sort(sort).skip(skip).limit(limit).exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return {
      items: docs.map((doc) => AiVideoJobMapper.toDomain(doc)),
      total,
    };
  }

  /**
   * Find jobs that are scheduled and due for publishing.
   * Used by the publisher cron/worker to pick up ready tasks.
   */
  async findScheduledDueJobs(beforeDate: Date): Promise<AiVideoJob[]> {
    const docs = await this.model
      .find({
        status: 'SCHEDULED',
        scheduledAt: { $lte: beforeDate },
      })
      .sort({ scheduledAt: 1 })
      .limit(50) // Process in batches
      .exec();
    return docs.map((doc) => AiVideoJobMapper.toDomain(doc));
  }

  async findApprovedJobs(): Promise<AiVideoJob[]> {
    const docs = await this.model
      .find({ status: 'APPROVED' })
      .sort({ createdAt: 1 })
      .exec();
    return docs.map((doc) => AiVideoJobMapper.toDomain(doc));
  }

  async isSlotBooked(tenantId: string, scheduledAt: Date): Promise<boolean> {
    const count = await this.model
      .countDocuments({
        tenantId,
        status: 'SCHEDULED',
        scheduledAt,
      })
      .exec();
    return count > 0;
  }

  async updateStatus(
    id: string,
    status: string,
    extra?: Partial<AiVideoJobSchemaClass>,
  ): Promise<AiVideoJob | null> {
    const update: Record<string, any> = { status, ...extra };
    const doc = await this.model
      .findByIdAndUpdate(id, { $set: update }, { new: true })
      .exec();
    return doc ? AiVideoJobMapper.toDomain(doc) : null;
  }

  async countByTenantAndDateRange(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<number> {
    return this.model
      .countDocuments({
        tenantId,
        createdAt: { $gte: startDate, $lt: endDate },
        status: { $nin: ['CANCELLED', 'REJECTED'] },
      })
      .exec();
  }

  private buildFilter(
    query: AiVideoJobQuery,
  ): FilterQuery<AiVideoJobSchemaDocument> {
    const filter: FilterQuery<AiVideoJobSchemaDocument> = {
      tenantId: query.tenantId,
    };
    if (query.status) {
      filter.status = Array.isArray(query.status)
        ? { $in: query.status }
        : query.status;
    }
    if (query.facebookPageId) {
      filter.facebookPageId = query.facebookPageId;
    }
    return filter;
  }
}
