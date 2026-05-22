import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AiVideoJobService } from '../services/ai-video-job.service';
import { FacebookPublisherService } from '../services/facebook-publisher.service';
import {
  CreateAiVideoJobDto,
  PublishNowDto,
  RejectJobDto,
  GenerateContentDto,
} from '../dto/ai-video-job.dto';
import { AiVideoJob } from '../domain/ai-video-job';
import { RequirePermission } from '../../common/permissions/permission.decorator';
import { ClsService } from 'nestjs-cls';

@ApiTags('AI Video')
@Controller({
  path: 'ai-video/jobs',
  version: '1',
})
export class AiVideoJobController {
  constructor(
    private readonly jobService: AiVideoJobService,
    private readonly publisherService: FacebookPublisherService,
    private readonly cls: ClsService,
  ) {}

  // ── CRUD ──────────────────────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: 'Create a new AI Video Job' })
  @RequirePermission('create', 'settings')
  async create(@Body() dto: CreateAiVideoJobDto): Promise<AiVideoJob> {
    return this.jobService.createJob(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all Video Jobs for the current tenant' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'facebookPageId', required: false, type: String })
  @RequirePermission('view', 'settings')
  async list(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('status') status?: string,
    @Query('facebookPageId') facebookPageId?: string,
  ) {
    return this.jobService.findPaginated(
      Number(page),
      Math.min(Number(limit), 100),
      status,
      facebookPageId,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a Video Job by ID' })
  @RequirePermission('view', 'settings')
  async findOne(@Param('id') id: string): Promise<AiVideoJob> {
    return this.jobService.findById(id);
  }

  @Get(':id/audit-log')
  @ApiOperation({ summary: 'Get the audit trail for a Video Job' })
  @RequirePermission('view', 'settings')
  async getAuditLog(@Param('id') id: string) {
    return this.jobService.getAuditLog(id);
  }

  // ── Approval workflow ─────────────────────────────────────────────────

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a video for scheduling/publishing' })
  @RequirePermission('manage_system', 'settings')
  async approve(@Param('id') id: string): Promise<AiVideoJob> {
    return this.jobService.approve(id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a video with a reason' })
  @RequirePermission('manage_system', 'settings')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectJobDto,
  ): Promise<AiVideoJob> {
    return this.jobService.reject(id, dto);
  }

  @Post(':id/generate-content')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate social media caption and hashtags using AI' })
  @RequirePermission('edit', 'settings')
  async generateContent(
    @Param('id') id: string,
    @Body() dto: GenerateContentDto,
  ): Promise<AiVideoJob> {
    return this.jobService.generateContent(id, dto);
  }


  // ── Publishing ────────────────────────────────────────────────────────

  @Post(':id/publish-now')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Immediately publish a video to its target Facebook Page',
  })
  @RequirePermission('manage_system', 'settings')
  async publishNow(
    @Param('id') id: string,
    @Body() dto: PublishNowDto,
  ) {
    const job = await this.jobService.findById(id);
    const tenantId = this.cls.get('tenantId');

    // Allow publish from: CREATED, APPROVED, PUBLISH_FAILED
    const allowedStatuses = ['CREATED', 'APPROVED', 'PUBLISH_FAILED'];
    if (!allowedStatuses.includes(job.status)) {
      return {
        success: false,
        message: `Cannot publish a job in status "${job.status}". Allowed: ${allowedStatuses.join(', ')}`,
      };
    }

    if (!job.sourceUrl) {
      return {
        success: false,
        message: 'No video source URL available. Upload a video first.',
      };
    }

    if (!job.facebookPageId) {
      return {
        success: false,
        message: 'No target Facebook Page ID configured for this job.',
      };
    }

    const caption = dto.caption ?? job.caption ?? '';

    try {
      const result = await this.publisherService.publishVideo(
        tenantId,
        job.id,
        job.facebookPageId,
        job.sourceUrl,
        caption,
      );

      return {
        success: true,
        platformVideoId: result.platformVideoId,
        platformPostId: result.platformPostId,
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Publishing failed',
      };
    }
  }
}
