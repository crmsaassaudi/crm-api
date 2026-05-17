import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
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
    const tenantId = this.cls.get('tenantId');
    return this.repository.findAll(tenantId);
  }

  async findById(id: string): Promise<EscalationPolicy> {
    const tenantId = this.cls.get('tenantId');
    const policy = await this.repository.findById(tenantId, id);
    if (!policy) throw new NotFoundException('Escalation Policy not found');
    return policy;
  }

  async create(dto: CreateEscalationPolicyDto): Promise<EscalationPolicy> {
    const tenantId = this.cls.get('tenantId');
    try {
      return await this.repository.create({ ...dto, tenantId });
    } catch (error) {
      if (error?.code === 11000) {
        throw new ConflictException(
          `Escalation Policy with name "${dto.name}" already exists`,
        );
      }
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateEscalationPolicyDto,
  ): Promise<EscalationPolicy> {
    const tenantId = this.cls.get('tenantId');
    try {
      const policy = await this.repository.update(tenantId, id, dto);
      if (!policy) throw new NotFoundException('Escalation Policy not found');
      return policy;
    } catch (error) {
      if (error?.code === 11000) {
        throw new ConflictException(
          `Escalation Policy with name "${dto.name}" already exists`,
        );
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Escalation Policy not found');
  }
}
