import {
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
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../common/permissions/permission.decorator';
import {
  CreatePublicationInstancesDto,
  CreateSocialContentAssetDto,
  ListPublicationInstancesQueryDto,
  ListSocialContentAssetsQueryDto,
  RejectSocialContentAssetVersionDto,
  UpdatePublicationInstanceDto,
  UpdateSocialContentAssetDto,
} from './dto/social-post.dto';
import { SocialContentAssetsService } from './services/social-posts.service';

@ApiTags('Social Content Assets')
@Controller({
  path: 'social-content-assets',
  version: '1',
})
export class SocialContentAssetsController {
  constructor(private readonly service: SocialContentAssetsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a reusable social content asset' })
  @RequirePermission('create', 'social_content_assets')
  create(@Body() dto: CreateSocialContentAssetDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List social content assets for the current tenant',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'approvalStatus', required: false, type: String })
  @RequirePermission('view', 'social_content_assets')
  list(@Query() query: ListSocialContentAssetsQueryDto) {
    return this.service.findPaginated(query);
  }

  @Get(':assetId')
  @ApiOperation({ summary: 'Get a social content asset with publications' })
  @RequirePermission('view', 'social_content_assets')
  findOne(@Param('assetId') assetId: string) {
    return this.service.findById(assetId);
  }

  @Patch(':assetId')
  @ApiOperation({ summary: 'Create a new content version for an asset' })
  @RequirePermission('edit', 'social_content_assets')
  update(
    @Param('assetId') assetId: string,
    @Body() dto: UpdateSocialContentAssetDto,
  ) {
    return this.service.update(assetId, dto);
  }

  @Delete(':assetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive a social content asset' })
  @RequirePermission('delete', 'social_content_assets')
  async archive(@Param('assetId') assetId: string) {
    await this.service.archive(assetId);
  }

  @Get(':assetId/versions')
  @ApiOperation({ summary: 'Get social content asset version history' })
  @RequirePermission('view', 'social_content_assets')
  getVersions(@Param('assetId') assetId: string) {
    return this.service.getVersions(assetId);
  }

  @Post(':assetId/versions/:versionId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a social content asset version' })
  @RequirePermission('approve', 'social_content_assets')
  approveVersion(
    @Param('assetId') assetId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.service.approveVersion(assetId, versionId);
  }

  @Post(':assetId/versions/:versionId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a social content asset version' })
  @RequirePermission('approve', 'social_content_assets')
  rejectVersion(
    @Param('assetId') assetId: string,
    @Param('versionId') versionId: string,
    @Body() dto: RejectSocialContentAssetVersionDto,
  ) {
    return this.service.rejectVersion(assetId, versionId, dto);
  }

  @Post(':assetId/publications')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create publication instances from an asset' })
  @RequirePermission('create', 'publication_instances')
  createPublications(
    @Param('assetId') assetId: string,
    @Body() dto: CreatePublicationInstancesDto,
  ) {
    return this.service.createPublications(assetId, dto);
  }
}

@ApiTags('Publication Instances')
@Controller({
  path: 'publication-instances',
  version: '1',
})
export class PublicationInstancesController {
  constructor(private readonly service: SocialContentAssetsService) {}

  @Get()
  @ApiOperation({ summary: 'List publication instances' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'platform', required: false, type: String })
  @ApiQuery({ name: 'assetId', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @RequirePermission('view', 'publication_instances')
  list(@Query() query: ListPublicationInstancesQueryDto) {
    return this.service.listPublicationInstances(query);
  }

  @Patch(':instanceId')
  @ApiOperation({ summary: 'Edit a pending publication snapshot or schedule' })
  @RequirePermission('edit', 'publication_instances')
  update(
    @Param('instanceId') instanceId: string,
    @Body() dto: UpdatePublicationInstanceDto,
  ) {
    return this.service.updatePublicationInstance(instanceId, dto);
  }

  @Post(':instanceId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a pending publication instance' })
  @RequirePermission('cancel', 'publication_instances')
  cancel(@Param('instanceId') instanceId: string) {
    return this.service.cancelPublicationInstance(instanceId);
  }

  @Post(':instanceId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a failed publication instance' })
  @RequirePermission('retry', 'publication_instances')
  retry(@Param('instanceId') instanceId: string) {
    return this.service.retryPublicationInstance(instanceId);
  }

  @Post(':instanceId/publish-now')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a pending publication instance now' })
  @RequirePermission('publish', 'publication_instances')
  publishNow(@Param('instanceId') instanceId: string) {
    return this.service.publishPublicationInstanceNow(instanceId);
  }
}
