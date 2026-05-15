import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { Ticket } from './domain/ticket';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DataMaskingInterceptor } from '../common/interceptors/data-masking.interceptor';
import { MaskedResource } from '../common/decorators/masked-resource.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import { RequirePermission } from '../common/permissions';

@ApiTags('Tickets')
@ApiBearerAuth()
@UseInterceptors(DataMaskingInterceptor)
@MaskedResource('Ticket')
@Controller({
  path: 'tickets',
  version: '1',
})
export class TicketsController {
  constructor(private readonly service: TicketsService) {}

  @Post()
  @RequirePermission('create', 'tickets')
  create(@Body() data: Partial<Ticket>) {
    return this.service.create(data);
  }

  @Get()
  @RequirePermission('view', 'tickets')
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @RequirePermission('view', 'tickets')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('edit', 'tickets')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: Partial<Ticket>) {
    return this.service.update(id, data);
  }

  @Delete(':id')
  @RequirePermission('delete', 'tickets')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
