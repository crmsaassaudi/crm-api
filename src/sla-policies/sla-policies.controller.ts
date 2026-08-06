import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SlaPoliciesService } from './sla-policies.service';
import { CreateSlaPolicyDto, UpdateSlaPolicyDto } from './dto/sla-policy.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';
import { LoadResource, UseAcl } from '../common/permissions';
import { SlaClockService } from './clock/sla-clock.service';
import { ClsService } from 'nestjs-cls';

@ApiTags('SLA Policies')
@ApiBearerAuth()
@Controller({ path: 'sla-policies', version: '1' })
export class SlaPoliciesController {
  constructor(
    private readonly service: SlaPoliciesService,
    private readonly clocks: SlaClockService,
    private readonly cls: ClsService,
  ) {}

  @Get('conversations/:conversationId/clocks')
  @RequirePermission('view', 'omni_channel')
  findConversationClocks(@Param('conversationId') conversationId: string) {
    return this.clocks.listForSubject(
      this.cls.get('tenantId'),
      'conversation',
      conversationId,
    );
  }

  /**
   * The clock history behind a ticket's SLA panel.
   *
   * `@UseAcl`/`@LoadResource` because the clocks describe a specific ticket:
   * `tickets:view` alone would expose the response times of any ticket outside
   * the agent's scope whose id they could guess.
   */
  @Get('tickets/:ticketId/clocks')
  @RequirePermission('view', 'tickets')
  @UseAcl('view', 'tickets', 'ticketId')
  @LoadResource('tickets')
  findTicketClocks(@Param('ticketId') ticketId: string) {
    return this.clocks.listForSubject(
      this.cls.get('tenantId'),
      'ticket',
      ticketId,
    );
  }

  @Get()
  @RequirePermission('view', 'sla_policies')
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @RequirePermission('view', 'sla_policies')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  @RequirePermission('create', 'sla_policies')
  create(@Body() dto: CreateSlaPolicyDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermission('edit', 'sla_policies')
  update(@Param('id') id: string, @Body() dto: UpdateSlaPolicyDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('delete', 'sla_policies')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
