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
import { TicketSettingsService } from './ticket-settings.service';
import {
  CreateTicketResolutionCodeDto,
  CreateTicketSourceDto,
  CreateTicketStatusDto,
  CreateTicketTypeDto,
  UpdateTicketResolutionCodeDto,
  UpdateTicketSourceDto,
  UpdateTicketStatusDto,
  UpdateTicketTypeDto,
} from './dto/ticket-settings.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

@ApiTags('Ticket Settings')
@ApiBearerAuth()
@Controller({ path: 'ticket-settings', version: '1' })
export class TicketSettingsController {
  constructor(private readonly service: TicketSettingsService) {}

  // ── Statuses ───────────────────────────────────────────────────────────
  @Get('statuses')
  @RequirePermission('view', 'settings')
  findAllStatuses() {
    return this.service.findAllStatuses();
  }

  @Post('statuses')
  @RequirePermission('manage_system', 'settings')
  createStatus(@Body() body: CreateTicketStatusDto) {
    return this.service.createStatus(body);
  }

  @Patch('statuses/:id')
  @RequirePermission('manage_system', 'settings')
  updateStatus(@Param('id') id: string, @Body() body: UpdateTicketStatusDto) {
    return this.service.updateStatus(id, body);
  }

  @Delete('statuses/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteStatus(@Param('id') id: string): Promise<void> {
    await this.service.deleteStatus(id);
  }

  // ── Types ──────────────────────────────────────────────────────────────
  @Get('types')
  @RequirePermission('view', 'settings')
  findAllTypes() {
    return this.service.findAllTypes();
  }

  @Post('types')
  @RequirePermission('manage_system', 'settings')
  createType(@Body() body: CreateTicketTypeDto) {
    return this.service.createType(body);
  }

  @Patch('types/:id')
  @RequirePermission('manage_system', 'settings')
  updateType(@Param('id') id: string, @Body() body: UpdateTicketTypeDto) {
    return this.service.updateType(id, body);
  }

  @Delete('types/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteType(@Param('id') id: string): Promise<void> {
    await this.service.deleteType(id);
  }

  // ── Sources ────────────────────────────────────────────────────────────
  @Get('sources')
  @RequirePermission('view', 'settings')
  findAllSources() {
    return this.service.findAllSources();
  }

  @Post('sources')
  @RequirePermission('manage_system', 'settings')
  createSource(@Body() body: CreateTicketSourceDto) {
    return this.service.createSource(body);
  }

  @Patch('sources/:id')
  @RequirePermission('manage_system', 'settings')
  updateSource(@Param('id') id: string, @Body() body: UpdateTicketSourceDto) {
    return this.service.updateSource(id, body);
  }

  @Delete('sources/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteSource(@Param('id') id: string): Promise<void> {
    await this.service.deleteSource(id);
  }

  // ── Resolution Codes ──────────────────────────────────────────────────
  @Get('resolution-codes')
  @RequirePermission('view', 'settings')
  findAllResolutionCodes() {
    return this.service.findAllResolutionCodes();
  }

  @Post('resolution-codes')
  @RequirePermission('manage_system', 'settings')
  createResolutionCode(@Body() body: CreateTicketResolutionCodeDto) {
    return this.service.createResolutionCode(body);
  }

  @Patch('resolution-codes/:id')
  @RequirePermission('manage_system', 'settings')
  updateResolutionCode(
    @Param('id') id: string,
    @Body() body: UpdateTicketResolutionCodeDto,
  ) {
    return this.service.updateResolutionCode(id, body);
  }

  @Delete('resolution-codes/:id')
  @RequirePermission('manage_system', 'settings')
  async deleteResolutionCode(@Param('id') id: string): Promise<void> {
    await this.service.deleteResolutionCode(id);
  }
}
