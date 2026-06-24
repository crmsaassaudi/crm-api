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
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { RequirePermission } from '../common/permissions/permission.decorator';
import {
  LifecycleStageDto,
  UpdateLifecycleStageDto,
  LifecycleStatusDto,
  UpdateLifecycleStatusDto,
} from './dto/crm-settings.dto';

/**
 * Hard cap on the serialized size of a free-form settings payload.
 * Prevents oversized documents (DoS / accidental dumps) from being persisted
 * into a single CrmSetting `value`. 100 KB is far above any legitimate
 * layout/list_views/validation_rules document.
 */
const MAX_SETTING_PAYLOAD_BYTES = 100_000;

function assertSettingPayloadSize(body: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(body ?? {});
  } catch {
    throw new BadRequestException('Setting payload is not serializable');
  }
  if (serialized.length > MAX_SETTING_PAYLOAD_BYTES) {
    throw new BadRequestException(
      `Setting payload exceeds maximum size of ${MAX_SETTING_PAYLOAD_BYTES} bytes`,
    );
  }
}

@ApiTags('CRM Settings')
@ApiBearerAuth()
@Controller({
  path: 'crm-settings',
  version: '1',
})
export class CrmSettingsController {
  constructor(
    private readonly service: CrmSettingsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  @Post('lifecycle/:objectId/stages')
  @RequirePermission('manage_system', 'settings')
  createLifecycleStage(
    @Param('objectId') objectId: string,
    @Body() body: LifecycleStageDto,
  ) {
    return this.service.createLifecycleStage(objectId, body);
  }

  @Put('lifecycle/:objectId/stages/:stageId')
  @RequirePermission('manage_system', 'settings')
  updateLifecycleStage(
    @Param('objectId') objectId: string,
    @Param('stageId') stageId: string,
    @Body() body: UpdateLifecycleStageDto,
  ) {
    return this.service.updateLifecycleStage(objectId, stageId, body);
  }

  @Delete('lifecycle/:objectId/stages/:stageId')
  @RequirePermission('manage_system', 'settings')
  deleteLifecycleStage(
    @Param('objectId') objectId: string,
    @Param('stageId') stageId: string,
  ) {
    return this.service.deleteLifecycleStage(objectId, stageId);
  }

  @Post('lifecycle/:objectId/stages/:stageId/statuses')
  @RequirePermission('manage_system', 'settings')
  createLifecycleStatus(
    @Param('objectId') objectId: string,
    @Param('stageId') stageId: string,
    @Body() body: LifecycleStatusDto,
  ) {
    return this.service.createLifecycleStatus(objectId, stageId, body);
  }

  @Put('lifecycle/:objectId/stages/:stageId/statuses/:statusId')
  @RequirePermission('manage_system', 'settings')
  updateLifecycleStatus(
    @Param('objectId') objectId: string,
    @Param('stageId') stageId: string,
    @Param('statusId') statusId: string,
    @Body() body: UpdateLifecycleStatusDto,
  ) {
    return this.service.updateLifecycleStatus(
      objectId,
      stageId,
      statusId,
      body,
    );
  }

  @Delete('lifecycle/:objectId/stages/:stageId/statuses/:statusId')
  @RequirePermission('manage_system', 'settings')
  deleteLifecycleStatus(
    @Param('objectId') objectId: string,
    @Param('stageId') stageId: string,
    @Param('statusId') statusId: string,
  ) {
    return this.service.deleteLifecycleStatus(objectId, stageId, statusId);
  }

  @Get(':key')
  @RequirePermission('view', 'settings')
  getSetting(@Param('key') key: string) {
    return this.service.getSetting(key);
  }

  /** PATCH is the standard verb used by the frontend settings pages. */
  @Patch(':key')
  @RequirePermission('manage_system', 'settings')
  async patchSetting(@Param('key') key: string, @Body() body: any) {
    assertSettingPayloadSize(body);
    const result = await this.service.updateSetting(
      key,
      body?.value !== undefined ? body.value : body,
    );

    // Notify listeners (e.g. AgentFallbackService) that a setting has changed
    this.eventEmitter.emit('settings.changed', {
      key,
      tenantId: result.tenantId ?? this.cls.get('tenantId'),
    });

    return result;
  }

  /** POST kept for backwards compatibility. */
  @Post(':key')
  @RequirePermission('manage_system', 'settings')
  async postSetting(@Param('key') key: string, @Body() body: any) {
    assertSettingPayloadSize(body);
    const result = await this.service.updateSetting(
      key,
      body?.value !== undefined ? body.value : body,
    );

    // Notify listeners (e.g. AgentFallbackService) that a setting has changed
    this.eventEmitter.emit('settings.changed', {
      key,
      tenantId: result.tenantId ?? this.cls.get('tenantId'),
    });

    return result;
  }
}
