import {
  Body,
  Controller,
  Get,
  Patch,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AiVideoJobService } from '../services/ai-video-job.service';
import { UpdateAiVideoSettingsDto } from '../dto/ai-video-settings.dto';
import { AiVideoSettings } from '../domain/ai-video-settings';
import { RequirePermission } from '../../common/permissions/permission.decorator';

@ApiTags('AI Video Settings')
@Controller({
  path: 'ai-video/settings',
  version: '1',
})
export class AiVideoSettingsController {
  constructor(private readonly jobService: AiVideoJobService) {}

  @Get()
  @ApiOperation({ summary: 'Get AI Video settings for the current tenant' })
  @RequirePermission('view', 'settings')
  async getSettings(): Promise<AiVideoSettings> {
    return this.jobService.getSettings();
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update AI Video settings for the current tenant' })
  @RequirePermission('create', 'settings')
  async updateSettings(
    @Body() dto: UpdateAiVideoSettingsDto,
  ): Promise<AiVideoSettings> {
    return this.jobService.updateSettings(dto);
  }
}
