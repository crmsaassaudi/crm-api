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
} from './dto/channel.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

@ApiTags('Channels')
@ApiBearerAuth()
@Controller({ path: 'channels', version: '1' })
export class ChannelsController {
  constructor(private readonly service: ChannelsService) {}

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

  @Post(':id/disconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('edit', 'channels')
  disconnect(@Param('id') id: string) {
    return this.service.disconnect(id);
  }
}
