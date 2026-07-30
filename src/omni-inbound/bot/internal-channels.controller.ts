import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Unprotected } from 'nest-keycloak-connect';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';
import { assertCrmBotInternalSecret } from './internal-secret.util';

/**
 * Internal endpoint for crm-bot Builder to fetch tenant channels.
 * Used in flow settings to let tenant owners select which channels a flow serves.
 *
 * GET /api/v1/internal/channels?tenantId=xxx
 * Headers: x-crm-internal-secret
 */
@Controller({ path: 'internal/channels', version: '1' })
export class InternalChannelsController {
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
    assertCrmBotInternalSecret(this.configService, secret);

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
}
