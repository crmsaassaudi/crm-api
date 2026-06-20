import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { LivechatWidgetService } from './livechat-widget.service';
import { LivechatWidget } from './domain/livechat-widget';

function extractTenantId(req: any): string {
  const tenantId = req.user?.tenantId ?? req.tenantId;
  if (!tenantId) throw new UnauthorizedException('Tenant context not found');
  return tenantId;
}

/**
 * Admin CRUD controller for livechat widgets.
 * All endpoints require authentication (tenant context via CLS).
 */
@ApiTags('Livechat Widgets')
@Controller({ path: 'livechat/widgets', version: '1' })
export class LivechatWidgetController {
  constructor(private readonly service: LivechatWidgetService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new livechat widget' })
  async create(
    @Body() body: Partial<LivechatWidget>,
    @Req() req: any,
  ): Promise<LivechatWidget> {
    const tenantId = extractTenantId(req);
    return this.service.create(tenantId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List all widgets for tenant' })
  @ApiQuery({ name: 'channelId', required: false })
  async findAll(
    @Req() req: any,
    @Query('channelId') channelId?: string,
  ): Promise<LivechatWidget[]> {
    const tenantId = extractTenantId(req);
    if (channelId) {
      return this.service.findByChannel(tenantId, channelId);
    }
    return this.service.findAll(tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get widget by ID' })
  async findOne(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<LivechatWidget> {
    const tenantId = extractTenantId(req);
    return this.service.findById(tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update widget settings' })
  async update(
    @Param('id') id: string,
    @Body() body: Partial<LivechatWidget>,
    @Req() req: any,
  ): Promise<LivechatWidget> {
    const tenantId = extractTenantId(req);
    return this.service.update(tenantId, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a widget' })
  async remove(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<{ deleted: boolean }> {
    const tenantId = extractTenantId(req);
    await this.service.delete(tenantId, id);
    return { deleted: true };
  }
}
