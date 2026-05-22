import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AiVideoJobRepository } from '../repositories/ai-video-job.repository';
import { AiVideoAuditLogRepository } from '../repositories/ai-video-audit-log.repository';
import { AiVideoJob, AiVideoJobStatus } from '../domain/ai-video-job';
import {
  CreateAiVideoJobDto,
  PublishNowDto,
  RejectJobDto,
} from '../dto/ai-video-job.dto';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';

@Injectable()
export class AiVideoJobService {
  private readonly logger = new Logger(AiVideoJobService.name);

  constructor(
    private readonly jobRepository: AiVideoJobRepository,
    private readonly auditLogRepository: AiVideoAuditLogRepository,
    private readonly channelRepository: ChannelRepository,
    private readonly cls: ClsService,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────
  async createJob(dto: CreateAiVideoJobDto): Promise<AiVideoJob> {
    const tenantId = this.cls.get('tenantId');
    const userId = this.cls.get('userId');

    // Validate that the target Facebook page is connected for this tenant
    const channel = await this.channelRepository.findByAccountWithCredentials(
      tenantId,
      'facebook',
      dto.facebookPageId,
    );
    if (!channel) {
      throw new BadRequestException(
        `Facebook Page ${dto.facebookPageId} is not connected to this tenant or is not in Connected status.`,
      );
    }

    if (dto.sourceType === 'url_import' && !dto.sourceUrl) {
      throw new BadRequestException(
        'sourceUrl is required when sourceType is url_import',
      );
    }

    const job = await this.jobRepository.create({
      tenantId,
      sourceType: dto.sourceType,
      sourceUrl: dto.sourceUrl,
      status: 'CREATED',
      facebookPageId: dto.facebookPageId,
      caption: dto.caption,
      hashtags: dto.hashtags ?? [],
      createdById: userId,
    });

    await this.auditLogRepository.record({
      tenantId,
      jobId: job.id,
      action: 'VIDEO_CREATED',
      actorType: 'user',
      actorId: userId,
      newStatus: 'CREATED',
      payload: {
        sourceType: dto.sourceType,
        sourceUrl: dto.sourceUrl,
        facebookPageId: dto.facebookPageId,
      },
    });

    this.logger.log(`Video job ${job.id} created for tenant ${tenantId}`);
    return job;
  }

  // ── Read ──────────────────────────────────────────────────────────────
  async findById(id: string): Promise<AiVideoJob> {
    const tenantId = this.cls.get('tenantId');
    const job = await this.jobRepository.findById(tenantId, id);
    if (!job) throw new NotFoundException('Video job not found');
    return job;
  }

  async findPaginated(
    page: number,
    limit: number,
    status?: string,
    facebookPageId?: string,
  ): Promise<{ items: AiVideoJob[]; total: number }> {
    const tenantId = this.cls.get('tenantId');
    return this.jobRepository.findPaginated(
      { tenantId, status, facebookPageId },
      page,
      limit,
    );
  }

  async getAuditLog(jobId: string) {
    const tenantId = this.cls.get('tenantId');
    // Ensure job exists and belongs to tenant
    const job = await this.jobRepository.findById(tenantId, jobId);
    if (!job) throw new NotFoundException('Video job not found');
    return this.auditLogRepository.findByJobId(tenantId, jobId);
  }

  // ── Status transitions ────────────────────────────────────────────────

  async updateStatus(
    jobId: string,
    newStatus: AiVideoJobStatus,
    extra?: Record<string, any>,
  ): Promise<AiVideoJob | null> {
    return this.jobRepository.updateStatus(jobId, newStatus, extra);
  }

  /**
   * Approve a video that is in PENDING_REVIEW or PROCESSED status.
   */
  async approve(jobId: string): Promise<AiVideoJob> {
    const tenantId = this.cls.get('tenantId');
    const userId = this.cls.get('userId');
    const job = await this.findById(jobId);

    if (job.status !== 'PENDING_REVIEW' && job.status !== 'PROCESSED') {
      throw new BadRequestException(
        `Cannot approve a job in status "${job.status}". Expected PENDING_REVIEW or PROCESSED.`,
      );
    }

    const updated = await this.jobRepository.updateStatus(jobId, 'APPROVED');

    await this.auditLogRepository.record({
      tenantId,
      jobId,
      action: 'APPROVED',
      actorType: 'user',
      actorId: userId,
      oldStatus: job.status,
      newStatus: 'APPROVED',
    });

    return updated!;
  }

  /**
   * Reject a video that is in PENDING_REVIEW status.
   */
  async reject(jobId: string, dto: RejectJobDto): Promise<AiVideoJob> {
    const tenantId = this.cls.get('tenantId');
    const userId = this.cls.get('userId');
    const job = await this.findById(jobId);

    if (job.status !== 'PENDING_REVIEW') {
      throw new BadRequestException(
        `Cannot reject a job in status "${job.status}". Expected PENDING_REVIEW.`,
      );
    }

    const updated = await this.jobRepository.updateStatus(jobId, 'REJECTED', {
      rejectReason: dto.reason,
    });

    await this.auditLogRepository.record({
      tenantId,
      jobId,
      action: 'REJECTED',
      actorType: 'user',
      actorId: userId,
      oldStatus: job.status,
      newStatus: 'REJECTED',
      payload: { reason: dto.reason },
    });

    return updated!;
  }

  /**
   * Mark a published job — called by the publisher worker/service.
   */
  async markAsPublished(
    jobId: string,
    platformVideoId: string,
    platformPostId?: string,
  ): Promise<void> {
    await this.jobRepository.updateStatus(jobId, 'PUBLISHED', {
      publishedAt: new Date(),
      platformVideoId,
      platformPostId,
    });
  }

  /**
   * Mark a job as PUBLISH_FAILED — called by the publisher on error.
   */
  async markAsFailed(jobId: string, errorDetails: string): Promise<void> {
    await this.jobRepository.updateStatus(jobId, 'PUBLISH_FAILED', {
      errorDetails,
    });
  }
}
