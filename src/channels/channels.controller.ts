import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { Unprotected } from 'nest-keycloak-connect';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ChannelsService } from './channels.service';
import {
  ConnectMetaChannelsDto,
  CreateChannelDto,
  CreateLivechatChannelDto,
  MetaAuthUrlQueryDto,
  UpdateChannelDto,
  UpdateChannelSupportDto,
} from './dto/channel.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';
import { ChannelSupportService } from './services/channel-support.service';
import { ClsService } from 'nestjs-cls';

@ApiTags('Channels')
@ApiBearerAuth()
@Controller({ path: 'channels', version: '1' })
export class ChannelsController {
  constructor(
    private readonly service: ChannelsService,
    private readonly supportService: ChannelSupportService,
    private readonly cls: ClsService,
  ) {}

  @Get()
  @RequirePermission('view', 'channels')
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @RequirePermission('view', 'channels')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  @RequirePermission('create', 'channels')
  create(@Body() dto: CreateChannelDto) {
    return this.service.create(dto);
  }

  /** Create a Livechat channel — no OAuth required, auto-Connected */
  @Post('livechat')
  @RequirePermission('create', 'channels')
  createLivechat(@Body() dto: CreateLivechatChannelDto) {
    return this.service.createLivechatChannel(dto);
  }

  /** Public endpoint — widget fetches its config (greeting, color, etc.) */
  @Get('livechat/:id/public-config')
  @Unprotected()
  getLivechatPublicConfig(@Param('id') id: string) {
    return this.service.getLivechatPublicConfig(id);
  }

  @Get('meta/auth-url')
  @RequirePermission('create', 'channels')
  getMetaAuthUrl(@Query() query: MetaAuthUrlQueryDto) {
    return this.service.buildMetaAuthUrl(query.type, query.openerOrigin);
  }

  @Get('meta/callback')
  @Unprotected()
  async metaCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const html = await this.service.handleMetaCallback({
      code,
      state,
      error,
      errorDescription,
    });
    res.type('html').send(html);
  }

  @Get('meta/oauth-result/:resultId')
  @RequirePermission('view', 'channels')
  getMetaOAuthResult(@Param('resultId') resultId: string) {
    return this.service.getMetaOAuthResult(resultId);
  }

  @Post('meta/connect')
  @RequirePermission('create', 'channels')
  connectMetaChannels(@Body() dto: ConnectMetaChannelsDto) {
    return this.service.connectMetaChannels(dto);
  }

  @Patch(':id')
  @RequirePermission('edit', 'channels')
  update(@Param('id') id: string, @Body() dto: UpdateChannelDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('delete', 'channels')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }

  /**
   * Replace the channel's support pool.
   *
   * Deliberately a separate route from `PATCH :id` with a stricter permission:
   * this payload decides who may be assigned to the channel's conversations, so
   * it is an authorization change, not a settings tweak. Editing a channel's
   * name must not imply the right to widen who can read its inbox.
   */
  @Patch(':id/support')
  @RequirePermission('manage_system', 'channels')
  updateSupport(@Param('id') id: string, @Body() dto: UpdateChannelSupportDto) {
    return this.supportService.updateSupport(id, dto);
  }

  /**
   * Agents allowed to serve this channel. The UI's assignee picker reads this
   * instead of filtering a full user list client-side, so what it offers and
   * what the server accepts cannot drift apart.
   *
   * `agentIds: null` means the channel does not restrict.
   */
  @Get(':id/eligible-agents')
  @RequirePermission('view', 'channels')
  async getEligibleAgents(@Param('id') id: string) {
    const tenantId = this.cls.get<string>('tenantId');
    const pool = await this.supportService.resolvePool(tenantId, id);
    return {
      channelId: id,
      mode: pool?.mode ?? 'open',
      agentIds: pool?.agentIds ?? null,
      groupIds: pool?.groupIds ?? [],
      excludedUserIds: pool?.excludedUserIds ?? [],
    };
  }

  @Get(':id/assignment-candidates')
  @RequirePermission('view', 'channels')
  getAssignmentCandidates(
    @Param('id') id: string,
    @Query('type') type?: 'agent' | 'group',
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.supportService.searchAssignmentCandidates(
      this.cls.get<string>('tenantId'),
      id,
      {
        type: type === 'group' ? 'group' : 'agent',
        search,
        limit: limit ? Number(limit) : undefined,
      },
    );
  }

  /**
   * The support pool with names resolved and group membership expanded — what
   * the admin UI renders. `manage_system` like the write route: it discloses
   * exactly who can read a channel's inbox.
   */
  @Get(':id/support/preview')
  @RequirePermission('manage_system', 'channels')
  previewSupport(@Param('id') id: string) {
    return this.supportService.describePool(
      this.cls.get<string>('tenantId'),
      id,
    );
  }

  @Post(':id/disconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('edit', 'channels')
  disconnect(@Param('id') id: string) {
    return this.service.disconnect(id);
  }
}
