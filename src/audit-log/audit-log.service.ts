import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  AuditLogSchemaClass,
  AuditLogSchemaDocument,
} from './entities/audit-log.schema';

export interface AuditLogRecordInput {
  action: string;
  targetEntityType: string;
  targetEntityId: string;
  actorId?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class AuditLogService {
  constructor(
    @InjectModel(AuditLogSchemaClass.name)
    private readonly auditLogModel: Model<AuditLogSchemaDocument>,
    private readonly cls: ClsService,
  ) {}

  async record(input: AuditLogRecordInput): Promise<void> {
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    const actorId =
      input.actorId || this.cls.get('userId') || this.cls.get('user.id');

    await this.auditLogModel.create({
      tenantId,
      actorId,
      action: input.action,
      targetEntityType: input.targetEntityType,
      targetEntityId: input.targetEntityId,
      timestamp: new Date(),
      ipAddress: this.cls.get('requestIp'),
      userAgent: this.cls.get('userAgent'),
      metadata: input.metadata,
    });
  }
}
