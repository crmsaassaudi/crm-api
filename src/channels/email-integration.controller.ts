import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import {
  ReconnectEmailIntegrationDto,
  TestEmailSyncDto,
  UpdateEmailIntegrationSettingsDto,
} from './dto/email-integration.dto';
import { EmailIntegrationService } from './services/email-integration.service';

@ApiTags('Email Integrations')
@ApiBearerAuth()
@Controller({ path: 'email-integrations', version: '1' })
export class EmailIntegrationController {
  constructor(
    private readonly service: EmailIntegrationService,
    private readonly cls: ClsService,
  ) {}

  @Get(':id/health')
  getHealth(@Param('id') id: string) {
    return this.service.getHealth(id);
  }

  @Patch(':id/settings')
  updateSettings(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateEmailIntegrationSettingsDto,
  ) {
    this.setRequestContext(req);
    return this.service.updateSettings(id, dto);
  }

  @Post(':id/reconnect')
  @HttpCode(HttpStatus.OK)
  reconnect(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ReconnectEmailIntegrationDto,
  ) {
    this.setRequestContext(req);
    return this.service.reconnect(id, dto);
  }

  @Post(':id/test-sync')
  @HttpCode(HttpStatus.OK)
  testSync(@Param('id') id: string, @Body() dto: TestEmailSyncDto) {
    return this.service.testSync(id, dto);
  }

  private setRequestContext(req: Request): void {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      null;
    const userAgent = (req.headers['user-agent'] as string) || null;

    this.cls.set('clientIp', ip);
    this.cls.set('userAgent', userAgent);
  }
}
