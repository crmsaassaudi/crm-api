import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CrmSettingsService } from './crm-settings.service';

/**
 * The tenant's navigation/workspace config, for the caller to render their
 * own sidebar from.
 *
 * Self-scoped by construction, for the same reason as `GET /me/object-config`:
 * `GET /crm-settings/navigation_workspaces` requires `settings:view`, which no
 * built-in role other than Administrator grants. For a Manager, Sales Rep or
 * Support Agent that 403'd, and the sidebar had no fallback for a failed fetch
 * beyond rendering an empty menu — so every non-admin lost all navigation, not
 * just the items they lack permission for.
 *
 * The payload carries no more sensitivity than what already reaches the
 * browser today: `useNavigationConfig` already filters every workspace/item by
 * the caller's own `GET /me/permissions` result before rendering anything
 * (see crm-web `useNavigationConfig.ts`), so exposing the raw config to any
 * authenticated tenant member changes nothing about what they can *see* — it
 * only lets that filtering step run at all instead of failing closed.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeNavigationController {
  constructor(
    private readonly settings: CrmSettingsService,
    private readonly cls: ClsService,
  ) {}

  @ApiOperation({
    summary: "The caller's tenant navigation/workspace configuration.",
    description:
      'Unfiltered tenant config — the client resolves per-item/workspace visibility from GET /me/permissions. No settings:view requirement: this is a UI-shell read, not a settings-admin read.',
  })
  @Get('navigation')
  @HttpCode(HttpStatus.OK)
  async myNavigation() {
    if (!this.cls.get<string>('userId')) {
      throw new UnauthorizedException('Not authenticated');
    }
    // tenantId comes from CLS inside CrmSettingsService; there is no id here
    // to scope or tamper with.
    return this.settings.getSetting('navigation_workspaces');
  }
}
