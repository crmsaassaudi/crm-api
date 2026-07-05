import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';

import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { ExportStorageFactory } from './export-storage.service';
import { ExportProgressTracker } from './export-progress.service';
import { ExportJobSchemaClass, ExportJobDocument } from './export-job.schema';
import { ExportFormat } from './types';

const MAX_QUEUED_PER_TENANT = Number(
  process.env.EXPORT_MAX_QUEUED_PER_TENANT ?? 3,
);
const MAX_PER_USER_PER_HOUR = Number(
  process.env.EXPORT_MAX_PER_USER_PER_HOUR ?? 5,
);

/**
 * Reusable API-side orchestration for exports: enqueue (with quota + audit +
 * history), status, cancel, list, and download. Modules supply their own
 * BullMQ queue + storage prefix so this stays entity-agnostic.
 *
 * Mirrors the bespoke logic in ContactsService (which predates this helper and
 * keeps extra owner-restriction handling).
 */
@Injectable()
export class ExportRequestService {
  constructor(
    @InjectModel(ExportJobSchemaClass.name)
    private readonly jobModel: Model<ExportJobDocument>,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    private readonly cls: ClsService,
    private readonly storageFactory: ExportStorageFactory,
    private readonly activityLog: ActivityLogService,
  ) {}

  private tenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }

  private userId(): string | undefined {
    return this.cls.get('userId');
  }

  async enqueue(opts: {
    entityType: string;
    queue: Queue;
    format?: ExportFormat;
    ids?: string[];
    legacyFilters?: Record<string, any>;
    filterSnapshot?: Record<string, any>;
    columns?: string[];
  }): Promise<{ jobId: string; status: 'queued' }> {
    const tenantId = this.tenantId();
    const userId = this.userId();
    await this.enforceQuota(opts.entityType, userId);

    const format: ExportFormat = opts.format ?? 'csv';
    const userGroupId = this.cls.get('userGroupId');
    const filterSnapshot = opts.filterSnapshot ?? { ids: opts.ids };

    const job = await opts.queue.add('export', {
      tenantId,
      userId,
      userGroupId,
      format,
      columns: opts.columns,
      filter: { ids: opts.ids },
      ids: opts.ids,
      legacyFilters: opts.legacyFilters,
    });

    await this.jobModel.create({
      tenantId,
      userId,
      userGroupId,
      entityType: opts.entityType,
      format,
      status: 'queued',
      bullJobId: String(job.id),
      filterSnapshot,
      selectedColumns: opts.columns,
      ip: this.cls.get('requestIp'),
      userAgent: this.cls.get('userAgent'),
    });

    await this.activityLog.create({
      targetType: 'Export',
      targetId: String(job.id),
      event: 'export',
      actorId: userId,
      payload: { module: opts.entityType, filter: filterSnapshot },
    });

    return { jobId: String(job.id), status: 'queued' };
  }

  private async enforceQuota(
    entityType: string,
    userId: string | undefined,
  ): Promise<void> {
    const inFlight = await this.jobModel.countDocuments({
      entityType,
      status: { $in: ['queued', 'active'] },
    });
    if (inFlight >= MAX_QUEUED_PER_TENANT) {
      throw new HttpException(
        'Too many exports in progress for this workspace. Please wait for one to finish.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.jobModel.countDocuments({
      entityType,
      userId,
      createdAt: { $gte: since },
    });
    if (recent >= MAX_PER_USER_PER_HOUR) {
      throw new HttpException(
        'Export rate limit reached. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async status(
    queue: Queue,
    jobId: string,
  ): Promise<{
    status: string;
    progress: unknown;
    result: any;
    failedReason?: string;
  }> {
    const job = await queue.getJob(jobId);
    if (!job) throw new NotFoundException('Export job not found');

    const tenantId = this.tenantId();
    const userId = this.userId();
    if (
      String(job.data?.tenantId ?? '') !== String(tenantId ?? '') ||
      (job.data?.userId && String(job.data.userId) !== String(userId ?? ''))
    ) {
      throw new NotFoundException('Export job not found');
    }

    return {
      status: await job.getState(),
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
    };
  }

  async cancel(entityType: string, jobId: string): Promise<{ status: string }> {
    const tenantId = this.tenantId();
    const userId = this.userId();

    const doc = await this.jobModel
      .findOne({ bullJobId: jobId, entityType })
      .lean()
      .exec();
    if (
      !doc ||
      String(doc.tenantId) !== String(tenantId) ||
      String(doc.userId) !== String(userId)
    ) {
      throw new NotFoundException('Export job not found');
    }
    if (['completed', 'failed', 'cancelled'].includes(doc.status)) {
      return { status: doc.status };
    }

    await ExportProgressTracker.requestCancel(this.redis, jobId);
    return { status: 'cancelling' };
  }

  private buildListFilter(
    entityType: string,
    tenantId: string,
    userId: string | undefined,
    status?: string,
  ): Record<string, any> {
    const filter: Record<string, any> = { tenantId, userId, entityType };
    const allowedStatuses = [
      'queued',
      'active',
      'completed',
      'failed',
      'cancelled',
    ];
    if (status && allowedStatuses.includes(status)) {
      filter.status = status;
    }
    return filter;
  }

  private async enrichListDocWithBullJob(
    doc: any,
    queue: Queue,
  ): Promise<void> {
    if (doc.status !== 'active' && doc.status !== 'queued') return;
    try {
      const bullJob = await queue.getJob(doc.bullJobId);
      if (bullJob) {
        (doc as any).status = await bullJob.getState();
        if (bullJob.progress && typeof bullJob.progress === 'object') {
          (doc as any).progress = bullJob.progress;
        }
      }
    } catch {
      // BullMQ job cleaned up — keep MongoDB status
    }
  }

  async list(
    entityType: string,
    queue: Queue,
    options: { page?: number; limit?: number; status?: string },
  ): Promise<{ data: any[]; total: number; page: number; limit: number }> {
    const tenantId = this.tenantId();
    const userId = this.userId();
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));
    const skip = (page - 1) * limit;

    const filter = this.buildListFilter(
      entityType,
      tenantId,
      userId,
      options.status,
    );

    const [data, total] = await Promise.all([
      this.jobModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'firstName lastName email avatar')
        .lean()
        .exec(),
      this.jobModel.countDocuments(filter).exec(),
    ]);

    await Promise.all(
      data.map((doc) => this.enrichListDocWithBullJob(doc, queue)),
    );

    // .lean() strips Mongoose virtuals/transforms, so ObjectId fields remain
    // as raw buffer objects. Sanitize them to plain strings for the API.
    const sanitized = data.map((doc) => this.sanitizeLeanDoc(doc));

    return { data: sanitized, total, page, limit };
  }

  /** Convert raw ObjectId fields from .lean() to plain strings and extract populated user. */
  private sanitizeLeanDoc(doc: any): any {
    const result = { ...doc };
    // _id → id (string), remove raw _id
    result.id = String(doc._id);
    delete result._id;
    delete result.__v;
    // ObjectId ref fields
    if (doc.tenantId) result.tenantId = String(doc.tenantId);
    // Extract populated user object if present
    if (doc.userId && typeof doc.userId === 'object' && doc.userId.firstName) {
      result.user = {
        firstName: doc.userId.firstName,
        lastName: doc.userId.lastName,
        email: doc.userId.email,
        avatar: doc.userId.avatar,
      };
      result.userId = String(doc.userId._id);
    } else if (doc.userId) {
      result.userId = String(doc.userId);
    }
    return result;
  }

  download(
    storagePrefix: string,
    token: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    return this.storageFactory.create(storagePrefix).readLocalExport(token);
  }
}
