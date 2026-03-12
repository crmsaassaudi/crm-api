import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EscalationPolicyRepository } from './infrastructure/persistence/document/repositories/escalation-policy.repository';
import { EscalationPolicy } from './domain/escalation-policy';
import {
  CreateEscalationPolicyDto,
  UpdateEscalationPolicyDto,
} from './dto/escalation-policy.dto';

@Injectable()
export class EscalationPoliciesService {
  constructor(
    private readonly repository: EscalationPolicyRepository,
    private readonly cls: ClsService,
  ) {}

  async findAll(): Promise<EscalationPolicy[]> {
    const tenant = this.cls.get('tenantId');
    return this.repository.findAll(tenant);
  }

  async findById(id: string): Promise<EscalationPolicy> {
    const tenant = this.cls.get('tenantId');
    const policy = await this.repository.findById(tenant, id);
    if (!policy) throw new NotFoundException('Escalation Policy not found');
    return policy;
  }

  async create(dto: CreateEscalationPolicyDto): Promise<EscalationPolicy> {
    const tenant = this.cls.get('tenantId');
    return this.repository.create({ ...dto, tenant });
  }

  async update(
    id: string,
    dto: UpdateEscalationPolicyDto,
  ): Promise<EscalationPolicy> {
    const tenant = this.cls.get('tenantId');
    const policy = await this.repository.update(tenant, id, dto);
    if (!policy) throw new NotFoundException('Escalation Policy not found');
    return policy;
  }

  async delete(id: string): Promise<void> {
    const tenant = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenant, id);
    if (!deleted) throw new NotFoundException('Escalation Policy not found');
  }
}
