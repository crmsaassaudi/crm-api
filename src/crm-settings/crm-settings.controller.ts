import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
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

  @Post('lifecycle/:objectId/stages')
  createLifecycleStage(@Param('objectId') objectId: string, @Body() body: any) {
    return this.service.createLifecycleStage(objectId, body);
  }

  @Put('lifecycle/:objectId/stages/:stageId')
  updateLifecycleStage(
    @Param('objectId') objectId: string,
    @Param('stageId') stageId: string,
    @Body() body: any,
  ) {
    return this.service.updateLifecycleStage(objectId, stageId, body);
  }

  @Delete('lifecycle/:objectId/stages/:stageId')
  deleteLifecycleStage(
    @Param('objectId') objectId: string,
    @Param('stageId') stageId: string,
  ) {
    return this.service.deleteLifecycleStage(objectId, stageId);
  }

  @Post('lifecycle/:objectId/stages/:stageId/statuses')
  createLifecycleStatus(
    @Param('objectId') objectId: string,
    @Param('stageId') stageId: string,
    @Body() body: any,
  ) {
    return this.service.createLifecycleStatus(objectId, stageId, body);
  }

  @Put('lifecycle/:objectId/stages/:stageId/statuses/:statusId')
  updateLifecycleStatus(
    @Param('objectId') objectId: string,
    @Param('stageId') stageId: string,
    @Param('statusId') statusId: string,
    @Body() body: any,
  ) {
    return this.service.updateLifecycleStatus(
      objectId,
      stageId,
      statusId,
      body,
    );
  }

  @Delete('lifecycle/:objectId/stages/:stageId/statuses/:statusId')
  deleteLifecycleStatus(
    @Param('objectId') objectId: string,
    @Param('stageId') stageId: string,
    @Param('statusId') statusId: string,
  ) {
    return this.service.deleteLifecycleStatus(objectId, stageId, statusId);
  }

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
