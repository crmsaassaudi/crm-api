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
  MetaAuthUrlQueryDto,
  UpdateChannelDto,
} from './dto/channel.dto';

@ApiTags('Channels')
@ApiBearerAuth()
@Controller({ path: 'channels', version: '1' })
export class ChannelsController {
  constructor(private readonly service: ChannelsService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  create(@Body() dto: CreateChannelDto) {
    return this.service.create(dto);
  }

  @Get('meta/auth-url')
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
  getMetaOAuthResult(@Param('resultId') resultId: string) {
    return this.service.getMetaOAuthResult(resultId);
  }

  @Post('meta/connect')
  connectMetaChannels(@Body() dto: ConnectMetaChannelsDto) {
    return this.service.connectMetaChannels(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateChannelDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }

  @Post(':id/disconnect')
  @HttpCode(HttpStatus.OK)
  disconnect(@Param('id') id: string) {
    return this.service.disconnect(id);
  }
}
