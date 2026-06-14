import {
  Controller,
  Get,
  Query,
  Headers,
  Logger,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Unprotected } from 'nest-keycloak-connect';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';

/**
 * Internal endpoint for crm-bot Builder to fetch tenant channels.
 * Used in flow settings to let tenant owners select which channels a flow serves.
 *
 * GET /api/v1/internal/channels?tenantId=xxx
 * Headers: x-crm-internal-secret
 */
@Controller({ path: 'internal/channels', version: '1' })
export class InternalChannelsController {
  private readonly logger = new Logger(InternalChannelsController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly cls: ClsService,
    private readonly channelRepo: ChannelRepository,
  ) {}

  @Get()
  @Unprotected()
  async listChannels(
    @Headers('x-crm-internal-secret') secret: string,
    @Query('tenantId') tenantId: string,
  ) {
    this.validateInternalSecret(secret);

    if (!tenantId) {
      throw new BadRequestException('tenantId query param is required');
    }

    return runWithTenantContext(this.cls, tenantId, async () => {
      const channels = await this.channelRepo.findAll(tenantId);

      return channels.map((ch) => ({
        id: ch.id,
        name: ch.name,
        type: ch.type,
        account: ch.account,
        status: ch.status,
      }));
    });
  }

  private validateInternalSecret(secret: string): void {
    const expected = this.configService.get<string>(
      'CRM_BOT_INTERNAL_SECRET',
      { infer: true },
    );
    if (!expected) {
      this.logger.warn(
        'CRM_BOT_INTERNAL_SECRET not configured — skipping validation',
      );
      return;
    }
    if (secret !== expected) {
      throw new ForbiddenException('Invalid internal secret');
    }
  }
}
