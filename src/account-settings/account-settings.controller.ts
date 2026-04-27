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

@ApiTags('Account Settings')
@ApiBearerAuth()
@Controller({ path: 'account-settings', version: '1' })
export class AccountSettingsController {
  constructor(private readonly service: AccountSettingsService) {}

  @Get('statuses')
  findAllStatuses() {
    return this.service.findAllStatuses();
  }

  @Post('statuses')
  createStatus(@Body() body: any) {
    return this.service.createStatus(body);
  }

  @Patch('statuses/:id')
  updateStatus(@Param('id') id: string, @Body() body: any) {
    return this.service.updateStatus(id, body);
  }

  @Delete('statuses/:id')
  async deleteStatus(@Param('id') id: string): Promise<void> {
    await this.service.deleteStatus(id);
  }

  @Get('types')
  findAllTypes() {
    return this.service.findAllTypes();
  }

  @Post('types')
  createType(@Body() body: any) {
    return this.service.createType(body);
  }

  @Patch('types/:id')
  updateType(@Param('id') id: string, @Body() body: any) {
    return this.service.updateType(id, body);
  }

  @Delete('types/:id')
  async deleteType(@Param('id') id: string): Promise<void> {
    await this.service.deleteType(id);
  }
}
