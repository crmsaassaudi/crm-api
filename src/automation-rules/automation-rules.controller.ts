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
import { AutomationRulesService } from './automation-rules.service';
import {
  CreateAutomationRuleDto,
  UpdateAutomationRuleDto,
} from './dto/automation-rule.dto';
import { RequirePermission } from '../common/permissions';

@ApiTags('Automation Rules')
@ApiBearerAuth()
@Controller({ path: 'automation-rules', version: '1' })
export class AutomationRulesController {
  constructor(private readonly service: AutomationRulesService) {}

  @Get()
  @RequirePermission('view', 'automation_rules')
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @RequirePermission('view', 'automation_rules')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  @RequirePermission('create', 'automation_rules')
  create(@Body() dto: CreateAutomationRuleDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermission('edit', 'automation_rules')
  update(@Param('id') id: string, @Body() dto: UpdateAutomationRuleDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('delete', 'automation_rules')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
