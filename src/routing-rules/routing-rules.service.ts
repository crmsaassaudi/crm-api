import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { RoutingRuleRepository } from './infrastructure/persistence/document/repositories/routing-rule.repository';
import { RoutingRule } from './domain/routing-rule';
import {
  CreateRoutingRuleDto,
  UpdateRoutingRuleDto,
} from './dto/routing-rule.dto';

@Injectable()
export class RoutingRulesService {
  constructor(
    private readonly repository: RoutingRuleRepository,
    private readonly cls: ClsService,
  ) {}

  async findAll(): Promise<RoutingRule[]> {
    const tenant = this.cls.get('tenantId');
    return this.repository.findAll(tenant);
  }

  async findById(id: string): Promise<RoutingRule> {
    const tenant = this.cls.get('tenantId');
    const rule = await this.repository.findById(tenant, id);
    if (!rule) throw new NotFoundException('Routing Rule not found');
    return rule;
  }

  async create(dto: CreateRoutingRuleDto): Promise<RoutingRule> {
    const tenant = this.cls.get('tenantId');
    return this.repository.create({ ...dto, tenant });
  }

  async update(id: string, dto: UpdateRoutingRuleDto): Promise<RoutingRule> {
    const tenant = this.cls.get('tenantId');
    const rule = await this.repository.update(tenant, id, dto);
    if (!rule) throw new NotFoundException('Routing Rule not found');
    return rule;
  }

  async delete(id: string): Promise<void> {
    const tenant = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenant, id);
    if (!deleted) throw new NotFoundException('Routing Rule not found');
  }

  async reorder(orderedIds: string[]): Promise<RoutingRule[]> {
    const tenant = this.cls.get('tenantId');
    return this.repository.reorder(tenant, orderedIds);
  }
}
