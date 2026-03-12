import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { SlaPolicyRepository } from './infrastructure/persistence/document/repositories/sla-policy.repository';
import { SlaPolicy } from './domain/sla-policy';
import { CreateSlaPolicyDto, UpdateSlaPolicyDto } from './dto/sla-policy.dto';

@Injectable()
export class SlaPoliciesService {
  constructor(
    private readonly repository: SlaPolicyRepository,
    private readonly cls: ClsService,
  ) {}

  async findAll(): Promise<SlaPolicy[]> {
    const tenant = this.cls.get('tenantId');
    return this.repository.findAll(tenant);
  }

  async findById(id: string): Promise<SlaPolicy> {
    const tenant = this.cls.get('tenantId');
    const policy = await this.repository.findById(tenant, id);
    if (!policy) throw new NotFoundException('SLA Policy not found');
    return policy;
  }

  async create(dto: CreateSlaPolicyDto): Promise<SlaPolicy> {
    const tenant = this.cls.get('tenantId');
    return this.repository.create({ ...dto, tenant });
  }

  async update(id: string, dto: UpdateSlaPolicyDto): Promise<SlaPolicy> {
    const tenant = this.cls.get('tenantId');
    const policy = await this.repository.update(tenant, id, dto);
    if (!policy) throw new NotFoundException('SLA Policy not found');
    return policy;
  }

  async delete(id: string): Promise<void> {
    const tenant = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenant, id);
    if (!deleted) throw new NotFoundException('SLA Policy not found');
  }
}
