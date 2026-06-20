import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { LivechatWidgetService } from './livechat-widget.service';
import { LivechatWidget } from './domain/livechat-widget';

/**
 * Admin CRUD controller for livechat widgets.
 * All endpoints require authentication (tenant context via CLS).
 *
 * tenantId is resolved by TenantInterceptor → stored in CLS,
 * NOT in req.user. This matches the pattern used by all other controllers.
 */
@ApiTags('Livechat Widgets')
@Controller({ path: 'livechat/widgets', version: '1' })
export class LivechatWidgetController {
  constructor(
    private readonly service: LivechatWidgetService,
    private readonly cls: ClsService,
  ) {}

  private getTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new UnauthorizedException('Tenant context not found');
    return tenantId;
  }

  @Post()
  @ApiOperation({ summary: 'Create a new livechat widget' })
  async create(@Body() body: Partial<LivechatWidget>): Promise<LivechatWidget> {
    return this.service.create(this.getTenantId(), body);
  }

  @Get()
  @ApiOperation({ summary: 'List all widgets for tenant' })
  @ApiQuery({ name: 'channelId', required: false })
  async findAll(
    @Query('channelId') channelId?: string,
  ): Promise<LivechatWidget[]> {
    const tenantId = this.getTenantId();
    if (channelId) {
      return this.service.findByChannel(tenantId, channelId);
    }
    return this.service.findAll(tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get widget by ID' })
  async findOne(@Param('id') id: string): Promise<LivechatWidget> {
    return this.service.findById(this.getTenantId(), id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update widget settings' })
  async update(
    @Param('id') id: string,
    @Body() body: Partial<LivechatWidget>,
  ): Promise<LivechatWidget> {
    return this.service.update(this.getTenantId(), id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a widget' })
  async remove(@Param('id') id: string): Promise<{ deleted: boolean }> {
    await this.service.delete(this.getTenantId(), id);
    return { deleted: true };
  }
}

