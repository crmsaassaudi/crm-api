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
    const tenant = this.cls.get('tenantId');
    return this.repository.findAll(tenant);
  }

  async findById(id: string): Promise<AutomationRule> {
    const tenant = this.cls.get('tenantId');
    const rule = await this.repository.findById(tenant, id);
    if (!rule) throw new NotFoundException('Automation Rule not found');
    return rule;
  }

  async create(dto: CreateAutomationRuleDto): Promise<AutomationRule> {
    const tenant = this.cls.get('tenantId');
    return this.repository.create({ ...dto, tenant });
  }

  async update(
    id: string,
    dto: UpdateAutomationRuleDto,
  ): Promise<AutomationRule> {
    const tenant = this.cls.get('tenantId');
    const rule = await this.repository.update(tenant, id, dto);
    if (!rule) throw new NotFoundException('Automation Rule not found');
    return rule;
  }

  async delete(id: string): Promise<void> {
    const tenant = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenant, id);
    if (!deleted) throw new NotFoundException('Automation Rule not found');
  }
}
