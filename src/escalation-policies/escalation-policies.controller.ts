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

@ApiTags('Escalation Policies')
@ApiBearerAuth()
@Controller({ path: 'escalation-policies', version: '1' })
export class EscalationPoliciesController {
  constructor(private readonly service: EscalationPoliciesService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  create(@Body() dto: CreateEscalationPolicyDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEscalationPolicyDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
