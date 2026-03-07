import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { CrmSettingsService } from './crm-settings.service';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('CRM Settings')
@ApiBearerAuth()
@Controller({
    path: 'crm-settings',
    version: '1',
})
export class CrmSettingsController {
    constructor(private readonly service: CrmSettingsService) { }

    @Get(':key')
    getSetting(@Param('key') key: string) {
        return this.service.getSetting(key);
    }

    @Post(':key')
    updateSetting(@Param('key') key: string, @Body() body: any) {
        return this.service.updateSetting(key, body.value !== undefined ? body.value : body);
    }
}
