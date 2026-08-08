import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { LoadResource, RequirePermission, UseAcl } from '../common/permissions';
import { CampaignsService } from './campaigns.service';
import { CampaignRunnerService } from './campaign-runner.service';
import { CampaignSendersService } from './campaign-senders.service';
import { CAMPAIGN_CHANNELS, CampaignChannel } from './domain/campaign-channel';
import {
  CreateCampaignDto,
  ListCampaignsDto,
  ListRecipientsDto,
  PreviewAudienceDto,
  TestSendDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

/**
 * Campaigns — outbound broadcasts to a contact audience.
 *
 * Lifecycle transitions are their own endpoints rather than a `status` field on
 * PATCH. Each one has preconditions (an audience that resolves, a channel that
 * is still connected, a legal source status), and a PATCH that could set
 * `status: 'sending'` would be a way to start a send while skipping all of them.
 *
 * They are gated on `campaigns:launch` rather than `campaigns:edit`: writing a
 * draft and deciding to actually message tens of thousands of customers are
 * different levels of trust, and the permission catalog already separates them.
 */
@ApiTags('Campaigns')
@ApiBearerAuth()
@Controller({ path: 'campaigns', version: '1' })
export class CampaignsController {
  constructor(
    private readonly service: CampaignsService,
    private readonly runner: CampaignRunnerService,
    private readonly senders: CampaignSendersService,
  ) {}

  @Get()
  @RequirePermission('view', 'campaigns')
  list(@Query() query: ListCampaignsDto) {
    return this.service.list(query);
  }

  /** Declared before `:id` so "audience-preview" is never read as a campaign id. */
  @Post('audience-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('view', 'campaigns')
  @ApiOperation({ summary: 'Size an audience before the campaign is saved' })
  @ApiOkResponse({
    description:
      'total = contacts matched; estimatedReachable = those with a usable, non-refused destination',
  })
  previewAudience(@Body() dto: PreviewAudienceDto) {
    return this.service.previewAudience(dto);
  }

  /** Also before `:id`. What this campaign could send from, per channel. */
  @Get('senders/:channelType')
  @RequirePermission('view', 'campaigns')
  @ApiOperation({ summary: 'Sender accounts available for a campaign channel' })
  listSenders(@Param('channelType') channelType: string) {
    if (!(CAMPAIGN_CHANNELS as readonly string[]).includes(channelType)) {
      throw new BadRequestException(
        `Unsupported campaign channel "${channelType}".`,
      );
    }
    return this.senders.list(channelType as CampaignChannel);
  }

  @Post()
  @RequirePermission('create', 'campaigns')
  create(@Body() dto: CreateCampaignDto) {
    return this.service.create(dto);
  }

  // Record-level ACL from here down. `ownerId` is an authorization axis on a
  // campaign — the list is already narrowed by the caller's data scope, and
  // without these a rep could reach a campaign by id that their own list view
  // would never show them.
  @Get(':id')
  @RequirePermission('view', 'campaigns')
  @UseAcl('view', 'campaigns')
  @LoadResource('campaigns')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('edit', 'campaigns')
  @UseAcl('edit', 'campaigns')
  @LoadResource('campaigns')
  update(@Param('id') id: string, @Body() dto: UpdateCampaignDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('delete', 'campaigns')
  @UseAcl('delete', 'campaigns')
  @LoadResource('campaigns')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/duplicate')
  @RequirePermission('create', 'campaigns')
  duplicate(@Param('id') id: string) {
    return this.service.duplicate(id);
  }

  @Post(':id/launch')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('launch', 'campaigns')
  launch(@Param('id') id: string) {
    return this.service.launch(id);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('launch', 'campaigns')
  pause(@Param('id') id: string) {
    return this.service.pause(id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('launch', 'campaigns')
  resume(@Param('id') id: string) {
    return this.service.resume(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('launch', 'campaigns')
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }

  @Post(':id/retry-failed')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('launch', 'campaigns')
  retryFailed(@Param('id') id: string) {
    return this.service.retryFailed(id);
  }

  /**
   * Send one message to an address of the caller's choosing.
   *
   * Gated on `launch` and not `edit`: it uses the tenant's real credentials and
   * real quota, so it is a send, not a preview.
   */
  @Post(':id/test-send')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('launch', 'campaigns')
  @ApiOperation({ summary: 'Send this campaign once, to check how it renders' })
  testSend(@Param('id') id: string, @Body() dto: TestSendDto) {
    return this.runner.testSend(id, dto.destination);
  }

  @Get(':id/recipients')
  @RequirePermission('view', 'campaigns')
  @ApiOperation({
    summary: 'The send ledger: who was messaged, who was skipped',
  })
  listRecipients(@Param('id') id: string, @Query() query: ListRecipientsDto) {
    return this.service.listRecipients(id, query);
  }
}
