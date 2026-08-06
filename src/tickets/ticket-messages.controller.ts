import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TicketMessagesService } from './ticket-messages.service';
import {
  CreateTicketMessageDto,
  TicketTimelineQueryDto,
  UpdateTicketMessageDto,
} from './dto/ticket-message.dto';
import { LoadResource, RequirePermission, UseAcl } from '../common/permissions';

/**
 * The ticket's conversation and timeline.
 *
 * Its own controller because these are the only ticket routes gated on
 * `tickets:reply` — the capability that lets an agent reach a customer.
 *
 * Every route also carries the ticket's record-level ACL on top of the resource
 * grant: reading a ticket's thread is reading the ticket, and `tickets:view`
 * scoped to one org unit must not expose the conversation of a ticket outside
 * it to anyone who can guess an id.
 */
@ApiTags('Ticket Timeline')
@ApiBearerAuth()
@Controller({ path: 'tickets/:ticketId/timeline', version: '1' })
export class TicketMessagesController {
  constructor(private readonly service: TicketMessagesService) {}

  @Get()
  @RequirePermission('view', 'tickets')
  @UseAcl('view', 'tickets', 'ticketId')
  @LoadResource('tickets')
  @ApiOkResponse({ description: 'One cursor-paginated page, oldest first' })
  timeline(
    @Param('ticketId') ticketId: string,
    @Query() query: TicketTimelineQueryDto,
  ) {
    return this.service.timeline(ticketId, query);
  }

  /**
   * Post a reply or an internal note.
   *
   * Rate-limited because this is the one ticket route that can reach a
   * customer: a compromised agent session should not be able to fan a message
   * out through hundreds of tickets before anyone notices.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post()
  @RequirePermission('reply', 'tickets')
  @UseAcl('edit', 'tickets', 'ticketId')
  @LoadResource('tickets')
  create(
    @Param('ticketId') ticketId: string,
    @Body() dto: CreateTicketMessageDto,
  ) {
    return this.service.create(ticketId, dto);
  }

  @Patch(':messageId')
  @RequirePermission('reply', 'tickets')
  @UseAcl('edit', 'tickets', 'ticketId')
  @LoadResource('tickets')
  update(
    @Param('ticketId') ticketId: string,
    @Param('messageId') messageId: string,
    @Body() dto: UpdateTicketMessageDto,
  ) {
    return this.service.update(ticketId, messageId, dto);
  }

  @Delete(':messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('reply', 'tickets')
  @UseAcl('edit', 'tickets', 'ticketId')
  @LoadResource('tickets')
  remove(
    @Param('ticketId') ticketId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.service.remove(ticketId, messageId);
  }
}
