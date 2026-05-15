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
import { RequirePermission } from '../common/permissions';

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
  @RequirePermission('view', 'settings')
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
  @RequirePermission('manage_system', 'settings')
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
  @RequirePermission('view', 'settings')
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
  @RequirePermission('manage_system', 'settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update tenant profile (name, logo)' })
  async updateProfile(@Body() dto: { tenantName?: string; logoUrl?: string }) {
    const tenantId = this.cls.get('tenantId');
    return this.tenantsService.updateProfile(tenantId, dto);
  }
}
