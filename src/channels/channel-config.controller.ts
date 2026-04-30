import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { ChannelConfigService } from './channel-config.service';
import {
  VerifyAndSaveChannelConfigDto,
  UpdateChannelConfigDto,
} from './dto/channel-config.dto';
import { ChannelConfigAuditRepository } from './infrastructure/persistence/document/repositories/channel-config-audit.repository';

@ApiTags('Channel Config')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ChannelConfigController {
  constructor(
    private readonly service: ChannelConfigService,
    private readonly cls: ClsService,
    private readonly auditRepo: ChannelConfigAuditRepository,
  ) {}

  // -- Provider Schema Registry --

  @Get('channel-providers/schemas')
  getProviderSchemas() {
    return this.service.getProviderSchemas();
  }

  // -- CRUD --

  @Get('channel-configs')
  findAll() {
    return this.service.findAll();
  }

  @Get('channel-configs/:id')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post('channel-configs/verify-and-save')
  verifyAndSave(
    @Req() req: Request,
    @Body() dto: VerifyAndSaveChannelConfigDto,
  ) {
    this.setRequestContext(req);
    return this.service.verifyAndSave(dto);
  }

  @Patch('channel-configs/:id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateChannelConfigDto,
  ) {
    this.setRequestContext(req);
    return this.service.update(id, dto);
  }

  @Delete('channel-configs/:id')
  @HttpCode(HttpStatus.OK)
  deleteConfig(@Req() req: Request, @Param('id') id: string) {
    this.setRequestContext(req);
    return this.service.softDelete(id);
  }

  @Post('channel-configs/:id/set-default')
  @HttpCode(HttpStatus.OK)
  setDefault(@Req() req: Request, @Param('id') id: string) {
    this.setRequestContext(req);
    return this.service.setDefault(id);
  }

  // -- Phase 4: Migration Flow --

  /**
   * Pre-delete check: returns affected workflows and compatible fallback configs.
   * Frontend uses this to decide whether to show the migration modal.
   */
  @Get('channel-configs/:id/pre-delete-check')
  preDeleteCheck(@Param('id') id: string) {
    return this.service.preDeleteCheck(id);
  }

  /**
   * Migrate all workflow references from one config to another, then delete source.
   * Uses MongoDB transaction for atomicity.
   */
  @Post('channel-configs/:id/migrate-and-delete')
  @HttpCode(HttpStatus.OK)
  migrateAndDelete(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { targetConfigId: string },
  ) {
    this.setRequestContext(req);
    return this.service.migrateAndDelete(id, body.targetConfigId);
  }

  // -- Phase 4: Audit Log --

  /**
   * Get audit history for a specific config (paginated).
   * Used by the per-config "Activity Log" tab in UI (contextual audit).
   */
  @Get('channel-configs/:id/audit-log')
  async getAuditLog(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.auditRepo.findByConfig(id, {
      limit: limit ? parseInt(limit, 10) : 20,
      skip: skip ? parseInt(skip, 10) : 0,
    });
  }

  // -- Private: Extract IP + UserAgent for audit trail --

  /**
   * Store client IP and User-Agent in CLS context for audit service consumption.
   * This runs synchronously before the service method is called.
   */
  private setRequestContext(req: Request): void {
    try {
      const ip =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.ip ||
        null;
      const userAgent = (req.headers['user-agent'] as string) || null;

      this.cls.set('clientIp', ip);
      this.cls.set('userAgent', userAgent);
    } catch {
      // Silently ignore -- audit context is best-effort
    }
  }
}
