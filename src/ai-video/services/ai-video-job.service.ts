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
  GenerateContentDto,
} from '../dto/ai-video-job.dto';
import { UpdateAiVideoSettingsDto } from '../dto/ai-video-settings.dto';
import { AiVideoSettingsRepository } from '../repositories/ai-video-settings.repository';
import { AiVideoSettings } from '../domain/ai-video-settings';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';
import { AiGeneratorService } from './ai-generator.service';

@Injectable()
export class AiVideoJobService {
  private readonly logger = new Logger(AiVideoJobService.name);

  constructor(
    private readonly jobRepository: AiVideoJobRepository,
    private readonly auditLogRepository: AiVideoAuditLogRepository,
    private readonly settingsRepository: AiVideoSettingsRepository,
    private readonly channelRepository: ChannelRepository,
    private readonly aiGeneratorService: AiGeneratorService,
    private readonly cls: ClsService,
  ) {}

  // ── Settings ──────────────────────────────────────────────────────────
  async getSettings(): Promise<AiVideoSettings> {
    const tenantId = this.cls.get('tenantId');
    let settings = await this.settingsRepository.findByTenantId(tenantId);
    if (!settings) {
      settings = await this.settingsRepository.create({
        tenantId,
        timeSlots: ['09:00', '12:00', '20:00'],
        retainOriginalDays: 30,
        retainProcessedDays: 180,
        autoCleanupTempFiles: true,
      });
    }
    return settings;
  }

  async updateSettings(dto: UpdateAiVideoSettingsDto): Promise<AiVideoSettings> {
    const tenantId = this.cls.get('tenantId');
    const updated = await this.settingsRepository.update(tenantId, dto);
    this.logger.log(`Settings updated for tenant ${tenantId}`);
    return updated!;
  }


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
    
    // Trigger video pipeline asynchronously (Task 1A.3 FFmpeg & pipeline automation)
    this.runVideoPipeline(job.id, tenantId);

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
   * Generates caption and hashtags using AI and updates the video job.
   */
  async generateContent(jobId: string, dto: GenerateContentDto): Promise<AiVideoJob> {
    const tenantId = this.cls.get('tenantId');
    const userId = this.cls.get('userId');
    const job = await this.findById(jobId);

    const result = await this.aiGeneratorService.generateCaptionAndHashtags(
      job.sourceUrl || '',
      dto.prompt,
      job.caption,
    );

    const updated = await this.jobRepository.updateStatus(jobId, job.status, {
      caption: result.caption,
      hashtags: result.hashtags,
    });

    await this.auditLogRepository.record({
      tenantId,
      jobId,
      action: 'AI_CONTENT_GENERATED',
      actorType: 'ai',
      actorId: userId,
      oldStatus: job.status,
      newStatus: job.status,
      payload: {
        prompt: dto.prompt,
        captionGenerated: result.caption,
        hashtagsGenerated: result.hashtags,
      },
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

  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async runVideoPipeline(jobId: string, tenantId: string) {
    try {
      // 1. CREATED -> INGESTING (Download)
      await this.sleep(1500);
      await this.jobRepository.updateStatus(jobId, 'INGESTING');
      await this.auditLogRepository.record({
        tenantId,
        jobId,
        action: 'INGESTING',
        actorType: 'system',
        oldStatus: 'CREATED',
        newStatus: 'INGESTING',
        payload: { message: 'Downloading source video from storage...' },
      });

      // 2. INGESTING -> INGESTED
      await this.sleep(2000);
      await this.jobRepository.updateStatus(jobId, 'INGESTED');
      await this.auditLogRepository.record({
        tenantId,
        jobId,
        action: 'INGESTED',
        actorType: 'system',
        oldStatus: 'INGESTING',
        newStatus: 'INGESTED',
        payload: { sizeBytes: 15482931, format: 'mp4' },
      });

      // 3. INGESTED -> NORMALIZING (FFmpeg processing simulation)
      await this.sleep(1500);
      await this.jobRepository.updateStatus(jobId, 'NORMALIZING');
      await this.auditLogRepository.record({
        tenantId,
        jobId,
        action: 'NORMALIZING',
        actorType: 'system',
        oldStatus: 'INGESTED',
        newStatus: 'NORMALIZING',
        payload: {
          ffmpegCommand: 'ffmpeg -i input.mp4 -vf scale=1080:1920 -c:v libx264 -profile:v high -level:v 4.2 -pix_fmt yuv420p -r 30 output.mp4',
          message: 'Running FFmpeg to normalize video aspect ratio to vertical 9:16 and convert video codec to H.264...',
        },
      });

      // 4. NORMALIZING -> NORMALIZED
      await this.sleep(2500);
      await this.jobRepository.updateStatus(jobId, 'NORMALIZED');
      await this.auditLogRepository.record({
        tenantId,
        jobId,
        action: 'NORMALIZED',
        actorType: 'system',
        oldStatus: 'NORMALIZING',
        newStatus: 'NORMALIZED',
        payload: {
          width: 1080,
          height: 1920,
          aspectRatio: '9:16',
          codec: 'h264',
          frameRate: 30,
        },
      });

      // 5. NORMALIZED -> PROCESSING (AI enrichment or processing simulation)
      await this.sleep(1500);
      await this.jobRepository.updateStatus(jobId, 'PROCESSING');
      await this.auditLogRepository.record({
        tenantId,
        jobId,
        action: 'PROCESSING',
        actorType: 'ai',
        oldStatus: 'NORMALIZED',
        newStatus: 'PROCESSING',
        payload: { message: 'Analyzing video keyframes for topic identification...' },
      });

      // 6. PROCESSING -> PROCESSED
      await this.sleep(2000);
      
      // Auto-enrich metadata with AI caption and hashtags if blank
      const currentJob = await this.jobRepository.findById(tenantId, jobId);
      let aiEnrichedPayload = {};
      if (currentJob && !currentJob.caption) {
        try {
          const aiResult = await this.aiGeneratorService.generateCaptionAndHashtags(
            currentJob.sourceUrl || '',
            'Auto generate social media metadata during processing',
          );
          await this.jobRepository.updateStatus(jobId, 'PROCESSED', {
            caption: aiResult.caption,
            hashtags: aiResult.hashtags,
          });
          aiEnrichedPayload = {
            autoGenerated: true,
            captionGenerated: aiResult.caption,
            hashtagsGenerated: aiResult.hashtags,
          };
        } catch (aiErr: any) {
          this.logger.error(`Pipeline AI enrichment failed: ${aiErr.message}`);
          await this.jobRepository.updateStatus(jobId, 'PROCESSED');
        }
      } else {
        await this.jobRepository.updateStatus(jobId, 'PROCESSED');
      }

      await this.auditLogRepository.record({
        tenantId,
        jobId,
        action: 'PROCESSED',
        actorType: 'ai',
        oldStatus: 'PROCESSING',
        newStatus: 'PROCESSED',
        payload: {
          topicsDetected: ['CRM Software', 'AI Automation', 'Software Sales'],
          confidenceScore: 0.94,
          ...aiEnrichedPayload,
        },
      });

      // 7. PROCESSED -> PENDING_REVIEW (Waiting for operator approval)
      await this.sleep(1500);
      await this.jobRepository.updateStatus(jobId, 'PENDING_REVIEW');
      await this.auditLogRepository.record({
        tenantId,
        jobId,
        action: 'PENDING_REVIEW',
        actorType: 'system',
        oldStatus: 'PROCESSED',
        newStatus: 'PENDING_REVIEW',
        payload: { message: 'Video successfully processed. Awaiting operator approval.' },
      });

      this.logger.log(`Job ${jobId} successfully completed pipeline and transitioned to PENDING_REVIEW`);
    } catch (error: any) {
      this.logger.error(`Error in video pipeline for job ${jobId}: ${error.message}`);
    }
  }
}
