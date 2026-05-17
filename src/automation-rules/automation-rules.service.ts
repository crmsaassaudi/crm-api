import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AutomationRuleRepository } from './infrastructure/persistence/document/repositories/automation-rule.repository';
import { AutomationRule } from './domain/automation-rule';
import {
  CreateAutomationRuleDto,
  UpdateAutomationRuleDto,
} from './dto/automation-rule.dto';

@Injectable()
export class AutomationRulesService {
  constructor(
    private readonly repository: AutomationRuleRepository,
    private readonly cls: ClsService,
  ) {}

  async findAll(): Promise<AutomationRule[]> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.findAll(tenantId);
  }

  async findById(id: string): Promise<AutomationRule> {
    const tenantId = this.cls.get('tenantId');
    const rule = await this.repository.findById(tenantId, id);
    if (!rule) throw new NotFoundException('Automation Rule not found');
    return rule;
  }

  async create(dto: CreateAutomationRuleDto): Promise<AutomationRule> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.create({ ...dto, tenantId });
  }

  async update(
    id: string,
    dto: UpdateAutomationRuleDto,
  ): Promise<AutomationRule> {
    const tenantId = this.cls.get('tenantId');
    const rule = await this.repository.update(tenantId, id, dto);
    if (!rule) throw new NotFoundException('Automation Rule not found');
    return rule;
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Automation Rule not found');
  }
}
