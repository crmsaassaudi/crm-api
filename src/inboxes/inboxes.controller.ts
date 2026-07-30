import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../common/permissions/permission.decorator';
import { CreateInboxDto, UpdateInboxDto } from './dto/inbox.dto';
import { InboxesService } from './inboxes.service';

@ApiTags('Omni Inboxes')
@ApiBearerAuth()
@Controller({ path: 'inboxes', version: '1' })
export class InboxesController {
  constructor(private readonly inboxes: InboxesService) {}

  @Get()
  @RequirePermission('view', 'channels')
  list(@Query('includeArchived') includeArchived?: string): Promise<any[]> {
    return this.inboxes.list(includeArchived === 'true');
  }

  @Get(':id')
  @RequirePermission('view', 'channels')
  get(@Param('id') id: string): Promise<any> {
    return this.inboxes.get(id);
  }

  @Post()
  @RequirePermission('manage_system', 'channels')
  create(@Body() dto: CreateInboxDto): Promise<any> {
    return this.inboxes.create(dto);
  }

  @Patch(':id')
  @RequirePermission('manage_system', 'channels')
  update(@Param('id') id: string, @Body() dto: UpdateInboxDto): Promise<any> {
    return this.inboxes.update(id, dto);
  }

  @Patch(':id/channels/:channelId')
  @RequirePermission('manage_system', 'channels')
  attachChannel(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
  ): Promise<{ inboxId: string; channelId: string }> {
    return this.inboxes.attachChannel(id, channelId);
  }
}
