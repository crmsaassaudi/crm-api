import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ChannelConfigAuditSchemaClass,
  ChannelConfigAuditDocument,
} from '../entities/channel-config-audit.schema';

@Injectable()
export class ChannelConfigAuditRepository {
  constructor(
    @InjectModel(ChannelConfigAuditSchemaClass.name)
    private readonly model: Model<ChannelConfigAuditDocument>,
  ) {}

  /**
   * Write a new audit log entry.
   */
  async create(data: {
    tenantId: string;
    userId: string;
    configId: string;
    action: string;
    configName: string;
    providerType?: string | null;
    changes?: Record<string, any>;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await this.model.create(data);
  }

  /**
   * Get audit history for a specific config (paginated, newest first).
   * Used by the per-config "Activity Log" tab in UI.
   */
  async findByConfig(
    configId: string,
    options?: { limit?: number; skip?: number },
  ): Promise<{ logs: ChannelConfigAuditSchemaClass[]; total: number }> {
    const limit = options?.limit || 20;
    const skip = options?.skip || 0;

    const [logs, total] = await Promise.all([
      this.model
        .find({ configId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .setOptions({ skipTenantFilter: true } as any)
        .exec(),
      this.model.countDocuments({ configId }),
    ]);

    return { logs, total };
  }

  /**
   * Get audit history for a tenant (paginated, newest first).
   * Used by global audit view (future).
   */
  async findByTenant(
    tenantId: string,
    options?: { limit?: number; skip?: number },
  ): Promise<{ logs: ChannelConfigAuditSchemaClass[]; total: number }> {
    const limit = options?.limit || 50;
    const skip = options?.skip || 0;

    const [logs, total] = await Promise.all([
      this.model
        .find({ tenantId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.model.countDocuments({ tenantId }),
    ]);

    return { logs, total };
  }
}
