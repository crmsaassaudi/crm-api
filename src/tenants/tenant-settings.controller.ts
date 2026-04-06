import {
  Controller,
  Get,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TenantsService } from './tenants.service';
import { UpdateTenantI18nDto } from './dto/i18n-settings.dto';
import { UpdateTenantCrmSettingsDto } from './dto/crm-settings.dto';

@ApiTags('Tenants')
@ApiBearerAuth()
@Controller({
  path: 'tenants',
  version: '1',
})
export class TenantSettingsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly cls: ClsService,
  ) {}

  /**
   * GET /api/v1/tenants/i18n
   * Returns the current tenant's i18n settings.
   */
  @Get('i18n')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get tenant i18n settings',
    description:
      'Returns the locale, timezone, date format, and currency defaults for the current tenant.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        locale: 'vi',
        timezone: 'Asia/Ho_Chi_Minh',
        dateFormat: 'DD/MM/YYYY',
        currency: 'VND',
      },
    },
  })
  async getI18nSettings() {
    const tenantId = this.cls.get('tenantId');
    return this.tenantsService.getI18nSettings(tenantId);
  }

  /**
   * PATCH /api/v1/tenants/i18n
   * Updates the current tenant's i18n settings.
   */
  @Patch('i18n')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update tenant i18n settings',
    description:
      'Partially updates the tenant locale, timezone, date format, or currency.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        locale: 'vi',
        timezone: 'Asia/Ho_Chi_Minh',
        dateFormat: 'DD/MM/YYYY',
        currency: 'VND',
      },
    },
  })
  async updateI18nSettings(@Body() dto: UpdateTenantI18nDto) {
    const tenantId = this.cls.get('tenantId');
    return this.tenantsService.updateI18nSettings(tenantId, dto);
  }

  /**
   * GET /api/v1/tenants/profile
   * Returns the current tenant's profile (name, alias, logoUrl).
   */
  @Get('profile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get tenant profile' })
  @ApiOkResponse({
    schema: {
      example: {
        tenantName: 'Toan Corp',
        logoUrl: 'https://...',
        alias: 'toancorp',
      },
    },
  })
  async getProfile() {
    const tenantId = this.cls.get('tenantId');
    return this.tenantsService.getProfile(tenantId);
  }

  /**
   * PATCH /api/v1/tenants/profile
   * Updates the current tenant's profile.
   */
  @Patch('profile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update tenant profile (name, logo)' })
  async updateProfile(@Body() dto: { tenantName?: string; logoUrl?: string }) {
    const tenantId = this.cls.get('tenantId');
    return this.tenantsService.updateProfile(tenantId, dto);
  }

  // ─── CRM Settings ───────────────────────────────────────────────────────────

  /**
   * GET /api/v1/tenants/crm
   * Returns the current tenant's CRM configuration.
   */
  @Get('crm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get tenant CRM settings',
    description:
      'Returns leadManagementMode and migration status for the current tenant.',
  })
  @ApiOkResponse({
    schema: {
      example: { leadManagementMode: 'separated', isMigrating: false },
    },
  })
  async getCrmSettings() {
    const tenantId = this.cls.get('tenantId');
    return this.tenantsService.getCrmSettings(tenantId);
  }

  /**
   * PATCH /api/v1/tenants/crm
   * Updates the current tenant's CRM configuration.
   * Note: Switching leadManagementMode on a tenant with existing data
   * will be locked (isMigrating guard) until Phase 3 Migration Wizard is complete.
   */
  @Patch('crm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update tenant CRM settings',
    description:
      "Partially updates the tenant's CRM config (e.g. leadManagementMode). " +
      'Returns 409 if a migration is already in progress.',
  })
  @ApiOkResponse({
    schema: {
      example: { leadManagementMode: 'unified', isMigrating: false },
    },
  })
  async updateCrmSettings(@Body() dto: UpdateTenantCrmSettingsDto) {
    const tenantId = this.cls.get('tenantId');
    return this.tenantsService.updateCrmSettings(tenantId, dto);
  }
}
