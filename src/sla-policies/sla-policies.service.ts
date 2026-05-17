import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
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
    const tenantId = this.cls.get('tenantId');
    return this.repository.findAll(tenantId);
  }

  async findById(id: string): Promise<SlaPolicy> {
    const tenantId = this.cls.get('tenantId');
    const policy = await this.repository.findById(tenantId, id);
    if (!policy) throw new NotFoundException('SLA Policy not found');
    return policy;
  }

  async create(dto: CreateSlaPolicyDto): Promise<SlaPolicy> {
    const tenantId = this.cls.get('tenantId');
    try {
      return await this.repository.create({ ...dto, tenantId });
    } catch (error) {
      if (error?.code === 11000) {
        throw new ConflictException(
          `SLA Policy with name "${dto.name}" already exists`,
        );
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateSlaPolicyDto): Promise<SlaPolicy> {
    const tenantId = this.cls.get('tenantId');
    try {
      const policy = await this.repository.update(tenantId, id, dto);
      if (!policy) throw new NotFoundException('SLA Policy not found');
      return policy;
    } catch (error) {
      if (error?.code === 11000) {
        throw new ConflictException(
          `SLA Policy with name "${dto.name}" already exists`,
        );
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('SLA Policy not found');
  }
}
