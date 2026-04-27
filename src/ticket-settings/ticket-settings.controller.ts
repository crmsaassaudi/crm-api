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

@ApiTags('Ticket Settings')
@ApiBearerAuth()
@Controller({ path: 'ticket-settings', version: '1' })
export class TicketSettingsController {
  constructor(private readonly service: TicketSettingsService) {}

  // ── Statuses ───────────────────────────────────────────────────────────
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

  // ── Types ──────────────────────────────────────────────────────────────
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

  // ── Sources ────────────────────────────────────────────────────────────
  @Get('sources')
  findAllSources() {
    return this.service.findAllSources();
  }

  @Post('sources')
  createSource(@Body() body: any) {
    return this.service.createSource(body);
  }

  @Patch('sources/:id')
  updateSource(@Param('id') id: string, @Body() body: any) {
    return this.service.updateSource(id, body);
  }

  @Delete('sources/:id')
  async deleteSource(@Param('id') id: string): Promise<void> {
    await this.service.deleteSource(id);
  }

  // ── Resolution Codes ──────────────────────────────────────────────────
  @Get('resolution-codes')
  findAllResolutionCodes() {
    return this.service.findAllResolutionCodes();
  }

  @Post('resolution-codes')
  createResolutionCode(@Body() body: any) {
    return this.service.createResolutionCode(body);
  }

  @Patch('resolution-codes/:id')
  updateResolutionCode(@Param('id') id: string, @Body() body: any) {
    return this.service.updateResolutionCode(id, body);
  }

  @Delete('resolution-codes/:id')
  async deleteResolutionCode(@Param('id') id: string): Promise<void> {
    await this.service.deleteResolutionCode(id);
  }
}
