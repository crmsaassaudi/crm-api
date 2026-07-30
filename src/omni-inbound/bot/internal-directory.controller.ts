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
import { GroupRepository } from '../../groups/infrastructure/persistence/document/repositories/group.repository';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';

/**
 * Internal directory endpoints for the crm-bot Builder's Handoff block, which
 * lets a tenant owner target a specific group or agent.
 *
 * GET /api/v1/internal/agents?tenantId=xxx
 * GET /api/v1/internal/groups?tenantId=xxx
 * Headers: x-crm-internal-secret
 *
 * Returns only `{ id, name }` — enough to populate a picker, nothing more.
 */
@UseGuards(CrmBotInternalSecretGuard)
@Controller({ path: 'internal', version: '1' })
export class InternalDirectoryController {
  constructor(
    private readonly cls: ClsService,
    private readonly userRepository: UserRepository,
    private readonly groupRepository: GroupRepository,
  ) {}

  @Get('agents')
  @Unprotected()
  async listAgents(
    @Query('tenantId') tenantId: string,
  ): Promise<{ agents: { id: string; name: string }[] }> {
    this.assertTenantId(tenantId);

    return runWithTenantContext(this.cls, tenantId, async () => {
      const users = await this.userRepository.findManyByTenant(tenantId);

      return {
        agents: users.map((user) => ({
          id: String(user.id),
          name:
            [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
            user.email ||
            String(user.id),
        })),
      };
    });
  }

  @Get('groups')
  @Unprotected()
  async listGroups(
    @Query('tenantId') tenantId: string,
  ): Promise<{ groups: { id: string; name: string }[] }> {
    this.assertTenantId(tenantId);

    return runWithTenantContext(this.cls, tenantId, async () => {
      const groups = await this.groupRepository.findAll(tenantId, {
        isActive: true,
      });

      return {
        groups: groups.map((group) => ({
          id: String(group.id),
          name: group.name,
        })),
      };
    });
  }

  private assertTenantId(tenantId: string): void {
    if (!tenantId)
      throw new BadRequestException('tenantId query param is required');
  }
}
