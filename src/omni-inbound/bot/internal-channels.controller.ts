import {
  UseGuards,
  BadRequestException,
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import { Unprotected } from 'nest-keycloak-connect';
import { CrmBotInternalSecretGuard } from './crm-bot-internal-secret.guard';
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
@UseGuards(CrmBotInternalSecretGuard)
@Controller({ path: 'internal/channels', version: '1' })
export class InternalChannelsController {
  constructor(
    private readonly cls: ClsService,
    private readonly channelRepo: ChannelRepository,
  ) {}

  @Get()
  @Unprotected()
  async listChannels(@Query('tenantId') tenantId: string) {
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
