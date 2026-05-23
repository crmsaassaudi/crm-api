import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/permissions/permission.decorator';
import { AiVideoJob } from '../domain/ai-video-job';
import {
  CreateAiVideoJobDto,
  GenerateContentDto,
  RejectJobDto,
} from '../dto/ai-video-job.dto';
import { AiVideoJobService } from '../services/ai-video-job.service';

@ApiTags('AI Video')
@Controller({
  path: 'ai-video/jobs',
  version: '1',
})
export class AiVideoJobController {
  constructor(private readonly jobService: AiVideoJobService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new AI Video library job' })
  @RequirePermission('create', 'ai_video')
  async create(@Body() dto: CreateAiVideoJobDto): Promise<AiVideoJob> {
    return this.jobService.createJob(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List video jobs for the current tenant' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @RequirePermission('view', 'ai_video')
  async list(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('status') status?: string,
  ) {
    return this.jobService.findPaginated(
      Number(page),
      Math.min(Number(limit), 100),
      status,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a video job by ID' })
  @RequirePermission('view', 'ai_video')
  async findOne(@Param('id') id: string): Promise<AiVideoJob> {
    return this.jobService.findById(id);
  }

  @Get(':id/audit-log')
  @ApiOperation({ summary: 'Get the audit trail for a video job' })
  @RequirePermission('view', 'ai_video')
  async getAuditLog(@Param('id') id: string) {
    return this.jobService.getAuditLog(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a video for reuse in social posts' })
  @RequirePermission('manage_system', 'ai_video')
  async approve(@Param('id') id: string): Promise<AiVideoJob> {
    return this.jobService.approve(id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a video with a reason' })
  @RequirePermission('manage_system', 'ai_video')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectJobDto,
  ): Promise<AiVideoJob> {
    return this.jobService.reject(id, dto);
  }

  @Post(':id/generate-content')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate library caption and hashtags using AI' })
  @RequirePermission('edit', 'ai_video')
  async generateContent(
    @Param('id') id: string,
    @Body() dto: GenerateContentDto,
  ): Promise<AiVideoJob> {
    return this.jobService.generateContent(id, dto);
  }
}
