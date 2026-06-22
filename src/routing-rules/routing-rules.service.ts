import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { RoutingRuleRepository } from './infrastructure/persistence/document/repositories/routing-rule.repository';
import { RoutingRuleEvaluatorService } from './routing-rule-evaluator.service';
import { RoutingRule } from './domain/routing-rule';
import {
  CreateRoutingRuleDto,
  UpdateRoutingRuleDto,
} from './dto/routing-rule.dto';

@Injectable()
export class RoutingRulesService {
  constructor(
    private readonly repository: RoutingRuleRepository,
    private readonly evaluator: RoutingRuleEvaluatorService,
    private readonly cls: ClsService,
  ) {}

  async findAll(): Promise<RoutingRule[]> {
    const tenantId = this.cls.get('tenantId');
    return this.repository.findAll(tenantId);
  }

  async findById(id: string): Promise<RoutingRule> {
    const tenantId = this.cls.get('tenantId');
    const rule = await this.repository.findById(tenantId, id);
    if (!rule) throw new NotFoundException('Routing Rule not found');
    return rule;
  }

  async create(dto: CreateRoutingRuleDto): Promise<RoutingRule> {
    const tenantId = this.cls.get('tenantId');
    const rule = await this.repository.create({ ...dto, tenantId });
    this.evaluator.invalidateCache(tenantId);
    return rule;
  }

  async update(id: string, dto: UpdateRoutingRuleDto): Promise<RoutingRule> {
    const tenantId = this.cls.get('tenantId');
    const rule = await this.repository.update(tenantId, id, dto);
    if (!rule) throw new NotFoundException('Routing Rule not found');
    this.evaluator.invalidateCache(tenantId);
    return rule;
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Routing Rule not found');
    this.evaluator.invalidateCache(tenantId);
  }

  async reorder(orderedIds: string[]): Promise<RoutingRule[]> {
    const tenantId = this.cls.get('tenantId');
    const rules = await this.repository.reorder(tenantId, orderedIds);
    this.evaluator.invalidateCache(tenantId);
    return rules;
  }
}
