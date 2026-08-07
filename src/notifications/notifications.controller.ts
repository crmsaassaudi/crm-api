import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';

/**
 * The caller's own notification inbox — self-scoped like every other
 * `/me/*` controller: the subject is always whoever CLS says is authenticated,
 * never an id in the path or query.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me/notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @ApiOperation({ summary: "The caller's own notifications, newest first." })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'unreadOnly', required: false })
  @Get()
  list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    return this.service.listForCaller({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      unreadOnly: unreadOnly === 'true',
    });
  }

  @ApiOperation({ summary: "How many of the caller's own notifications are unread." })
  @Get('unread-count')
  async unreadCount() {
    return { count: await this.service.unreadCountForCaller() };
  }

  @ApiOperation({ summary: 'Mark one of the caller’s own notifications read.' })
  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(@Param('id') id: string) {
    await this.service.markRead(id);
  }

  @ApiOperation({ summary: "Mark all of the caller's own notifications read." })
  @Patch('read-all')
  markAllRead() {
    return this.service.markAllRead();
  }
}
