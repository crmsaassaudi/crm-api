import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AccountSettingsService } from './account-settings.service';
import {
  CreateAccountStatusDto,
  UpdateAccountStatusDto,
} from './dto/account-status.dto';
import {
  CreateAccountTypeDto,
  UpdateAccountTypeDto,
} from './dto/account-type.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

@ApiTags('Account Settings')
@ApiBearerAuth()
@Controller({ path: 'account-settings', version: '1' })
export class AccountSettingsController {
  constructor(private readonly service: AccountSettingsService) {}

  @Get('statuses')
  @RequirePermission('view', 'settings')
  findAllStatuses() {
    return this.service.findAllStatuses();
  }

  @Post('statuses')
  @RequirePermission('manage_system', 'settings')
  createStatus(@Body() body: CreateAccountStatusDto) {
    return this.service.createStatus(body);
  }

  @Patch('statuses/:id')
  @RequirePermission('manage_system', 'settings')
  updateStatus(@Param('id') id: string, @Body() body: UpdateAccountStatusDto) {
    return this.service.updateStatus(id, body);
  }

  @Delete('statuses/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteStatus(@Param('id') id: string): Promise<void> {
    await this.service.deleteStatus(id);
  }

  @Get('types')
  @RequirePermission('view', 'settings')
  findAllTypes() {
    return this.service.findAllTypes();
  }

  @Post('types')
  @RequirePermission('manage_system', 'settings')
  createType(@Body() body: CreateAccountTypeDto) {
    return this.service.createType(body);
  }

  @Patch('types/:id')
  @RequirePermission('manage_system', 'settings')
  updateType(@Param('id') id: string, @Body() body: UpdateAccountTypeDto) {
    return this.service.updateType(id, body);
  }

  @Delete('types/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteType(@Param('id') id: string): Promise<void> {
    await this.service.deleteType(id);
  }
}
