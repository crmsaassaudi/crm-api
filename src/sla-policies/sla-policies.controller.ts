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

@ApiTags('SLA Policies')
@ApiBearerAuth()
@Controller({ path: 'sla-policies', version: '1' })
export class SlaPoliciesController {
  constructor(private readonly service: SlaPoliciesService) {}

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
