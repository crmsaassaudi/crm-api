import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { RichMessageTemplateRepository } from './infrastructure/persistence/document/repositories/rich-message-template.repository';
import { RichMessageTemplate } from './domain/rich-message-template';
import {
  CreateRichMessageTemplateDto,
  UpdateRichMessageTemplateDto,
} from './dto/rich-message-template.dto';

@Injectable()
export class RichMessageTemplatesService {
  constructor(
    private readonly repository: RichMessageTemplateRepository,
    private readonly cls: ClsService,
  ) {}

  async findAll(query?: {
    type?: string;
    channelType?: string;
    search?: string;
  }): Promise<RichMessageTemplate[]> {
    const tenantId = this.cls.get('tenantId');
    const userId = this.cls.get('userId');
    return this.repository.findAll(tenantId, userId, {
      ...query,
      isActive: true,
    });
  }

  async create(
    dto: CreateRichMessageTemplateDto,
  ): Promise<RichMessageTemplate> {
    const tenantId = this.cls.get('tenantId');
    const userId = this.cls.get('userId');
    return this.repository.create({
      ...dto,
      tenantId,
      createdById: userId,
      isActive: dto.isActive ?? true,
    } as any);
  }

  async update(
    id: string,
    dto: UpdateRichMessageTemplateDto,
  ): Promise<RichMessageTemplate> {
    const tenantId = this.cls.get('tenantId');
    const result = await this.repository.update(tenantId, id, dto);
    if (!result) throw new NotFoundException('Rich message template not found');
    return result;
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    const deleted = await this.repository.delete(tenantId, id);
    if (!deleted)
      throw new NotFoundException('Rich message template not found');
  }
}
