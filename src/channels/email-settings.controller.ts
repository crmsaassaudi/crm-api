import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  EmailChannelSettingsService,
  EmailSettings,
} from './services/email-channel-settings.service';
import { GdprEmailService } from './services/gdpr-email.service';
import { ClsService } from 'nestjs-cls';

/**
 * EmailSettingsController — Tenant-level email configuration & GDPR.
 *
 * Endpoints:
 *   GET    /channels/email-settings              → current settings
 *   PUT    /channels/email-settings              → update (partial merge)
 *   GET    /channels/gdpr/contact/:id/emails     → export contact email metadata
 *   DELETE /channels/gdpr/contact/:id            → GDPR contact deletion
 */
@ApiTags('Email Settings')
@ApiBearerAuth()
@Controller({ path: 'channels', version: '1' })
export class EmailSettingsController {
  private readonly logger = new Logger(EmailSettingsController.name);

  constructor(
    private readonly emailSettings: EmailChannelSettingsService,
    private readonly gdprService: GdprEmailService,
    private readonly cls: ClsService,
  ) {}

  private getTenantId(): string {
    return this.cls.get('tenantId');
  }

  // ── Email Channel Settings ─────────────────────────────────────────

  @Get('email-settings')
  @ApiOperation({ summary: 'Get tenant email settings' })
  async getSettings(): Promise<EmailSettings> {
    return this.emailSettings.getSettings(this.getTenantId());
  }

  @Put('email-settings')
  @ApiOperation({ summary: 'Update tenant email settings' })
  async updateSettings(
    @Body() updates: Partial<EmailSettings>,
  ): Promise<EmailSettings> {
    return this.emailSettings.updateSettings(updates, this.getTenantId());
  }

  // ── GDPR Compliance ────────────────────────────────────────────────

  @Get('gdpr/contact/:contactId/emails')
  @ApiOperation({ summary: 'GDPR: Export contact email metadata' })
  async exportContactEmails(@Param('contactId') contactId: string) {
    return this.gdprService.exportContactEmailMetadata(
      contactId,
      this.getTenantId(),
    );
  }

  @Delete('gdpr/contact/:contactId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'GDPR: Remove contact from all emails' })
  async removeContactEmailData(@Param('contactId') contactId: string) {
    this.logger.warn(
      `[GDPR] Contact deletion requested: ${contactId} by tenant ${this.getTenantId()}`,
    );
    return this.gdprService.removeContactReference(
      contactId,
      this.getTenantId(),
    );
  }
}
