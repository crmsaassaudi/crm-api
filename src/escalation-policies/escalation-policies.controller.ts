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
import { EscalationPoliciesService } from './escalation-policies.service';
import {
  CreateEscalationPolicyDto,
  UpdateEscalationPolicyDto,
} from './dto/escalation-policy.dto';
import { RequirePermission } from '../common/permissions';

@ApiTags('Escalation Policies')
@ApiBearerAuth()
@Controller({ path: 'escalation-policies', version: '1' })
export class EscalationPoliciesController {
  constructor(private readonly service: EscalationPoliciesService) {}

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
  create(@Body() dto: CreateEscalationPolicyDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermission('edit', 'sla_policies')
  update(@Param('id') id: string, @Body() dto: UpdateEscalationPolicyDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('delete', 'sla_policies')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
