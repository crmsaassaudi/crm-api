import { Controller, Get, Post, Patch, Body, Param } from '@nestjs/common';
import { CrmSettingsService } from './crm-settings.service';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('CRM Settings')
@ApiBearerAuth()
@Controller({
  path: 'crm-settings',
  version: '1',
})
export class CrmSettingsController {
  constructor(private readonly service: CrmSettingsService) {}

  @Get(':key')
  getSetting(@Param('key') key: string) {
    return this.service.getSetting(key);
  }

  /** PATCH is the standard verb used by the frontend settings pages. */
  @Patch(':key')
  patchSetting(@Param('key') key: string, @Body() body: any) {
    return this.service.updateSetting(
      key,
      body.value !== undefined ? body.value : body,
    );
  }

  /** POST kept for backwards compatibility. */
  @Post(':key')
  postSetting(@Param('key') key: string, @Body() body: any) {
    return this.service.updateSetting(
      key,
      body.value !== undefined ? body.value : body,
    );
  }
}
