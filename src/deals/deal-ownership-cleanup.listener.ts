import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import {
  DealSchemaClass,
  DealSchemaDocument,
} from './infrastructure/persistence/document/entities/deal.schema';
import { EntityAuditService } from '../common/audit/entity-audit.service';

@Injectable()
export class DealOwnershipCleanupListener {
  private readonly logger = new Logger(DealOwnershipCleanupListener.name);

  constructor(
    @InjectModel(DealSchemaClass.name)
    private readonly dealModel: Model<DealSchemaDocument>,
    private readonly entityAudit: EntityAuditService,
  ) {}

  @OnEvent('user.removed-from-tenant')
  async onUserRemoved(payload: {
    tenantId: string;
    userId: string;
  }): Promise<void> {
    const tenantId = payload?.tenantId;
    const userId = payload?.userId;
    if (!tenantId || !userId) return;

    try {
      const affected = await this.dealModel
        .find({ tenantId, ownerId: userId, deletedAt: null })
        .select({ _id: 1 })
        .setOptions({ isPlatformQuery: true } as any)
        .lean()
        .exec();
      if (affected.length === 0) return;

      await this.dealModel
        .updateMany(
          { tenantId, ownerId: userId, deletedAt: null },
          {
            $set: {
              ownerId: null,
              unassignedReason: 'owner_removed_from_tenant',
            },
          },
        )
        .setOptions({ isPlatformQuery: true } as any)
        .exec();

      for (const doc of affected) {
        this.entityAudit.emit({
          entity: 'deal',
          entityType: 'DEAL',
          entityId: String(doc._id),
          kind: 'updated',
          oldSnapshot: { ownerId: userId },
          newSnapshot: {
            ownerId: null,
            unassignedReason: 'owner_removed_from_tenant',
          },
        });
      }

      this.logger.log(
        `Unassigned ${affected.length} deal(s) owned by removed user ${userId} in tenant ${tenantId}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Deal ownership cleanup failed for tenant ${tenantId}, user ${userId}: ${err.message}`,
      );
    }
  }
}
