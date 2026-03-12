import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CannedResponseRepository } from './infrastructure/persistence/document/repositories/canned-response.repository';
import { CannedResponse } from './domain/canned-response';
import {
  CreateCannedResponseDto,
  UpdateCannedResponseDto,
} from './dto/canned-response.dto';

@Injectable()
export class CannedResponsesService {
  constructor(
    private readonly repository: CannedResponseRepository,
    private readonly cls: ClsService,
  ) {}

  async findAll(query?: {
    scope?: string;
    category?: string;
    search?: string;
  }): Promise<CannedResponse[]> {
    const tenant = this.cls.get('tenantId');
    const userId = this.cls.get('userId');
    return this.repository.findAll(tenant, userId, query);
  }

  async create(dto: CreateCannedResponseDto): Promise<CannedResponse> {
    const tenant = this.cls.get('tenantId');
    const userId = this.cls.get('userId');
    return this.repository.create({ ...dto, tenant, createdBy: userId });
  }

  async update(
    id: string,
    dto: UpdateCannedResponseDto,
  ): Promise<CannedResponse> {
    const tenant = this.cls.get('tenantId');
    const result = await this.repository.update(tenant, id, dto);
    if (!result) throw new NotFoundException('Canned response not found');
    return result;
  }

  async delete(id: string): Promise<void> {
    const tenant = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenant, id);
    if (!deleted) throw new NotFoundException('Canned response not found');
  }
}
