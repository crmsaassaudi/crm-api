import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Connection, Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { AssignmentCoreService } from '../core/assignment-core.service';
import { AssignmentObjectType } from '../domain/assignment.types';
import {
  AssignmentQueueItemDocument,
  AssignmentQueueItemSchemaClass,
} from '../infrastructure/persistence/assignment-queue-item.schema';

@Injectable()
export class AssignmentQueueCommandService {
  constructor(
    @InjectModel(AssignmentQueueItemSchemaClass.name)
    private readonly queue: Model<AssignmentQueueItemDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly core: AssignmentCoreService,
    private readonly cls: ClsService,
  ) {}

  async claim(queueItemId: string, requestedAssigneeId?: string) {
    const tenantId = this.tenantId;
    const actorId = this.cls.get<string>('userId');
    const assigneeId = requestedAssigneeId ?? actorId;
    if (!assigneeId) {
      throw new ConflictException('No assignee was provided or resolved');
    }
    const item = await this.acquire(queueItemId, tenantId, 'claiming');
    try {
      await this.assertEligibleAssignee(
        tenantId,
        String(item.groupId),
        assigneeId,
      );
      const decision = await this.core.assign({
        tenantId,
        objectType: item.objectType as AssignmentObjectType,
        entityId: item.entityId,
        manualAssigneeId: assigneeId,
        owningGroupId: String(item.groupId),
        source: 'manual',
        performedByUserId: actorId ?? null,
        metadata: {
          queueItemId,
          queueOperationId: item.operationId,
          command: 'claim',
        },
      });
      if (decision.outcome !== 'assigned') {
        await this.release(item._id, item.operationId);
      }
      return decision;
    } catch (error) {
      await this.release(item._id, item.operationId);
      throw error;
    }
  }

  async retry(queueItemId: string) {
    const tenantId = this.tenantId;
    const actorId = this.cls.get<string>('userId');
    const item = await this.acquire(queueItemId, tenantId, 'retrying');
    try {
      const decision = await this.core.assign({
        tenantId,
        objectType: item.objectType as AssignmentObjectType,
        entityId: item.entityId,
        targetGroupIds: [String(item.groupId)],
        owningGroupId: String(item.groupId),
        skipRules: true,
        source: 'retry',
        performedByUserId: actorId ?? null,
        metadata: {
          queueItemId,
          queueOperationId: item.operationId,
          command: 'retry',
        },
      });
      if (decision.outcome !== 'assigned') {
        await this.release(item._id, item.operationId);
      }
      return decision;
    } catch (error) {
      await this.release(item._id, item.operationId);
      throw error;
    }
  }

  private async acquire(
    queueItemId: string,
    tenantId: string,
    status: 'claiming' | 'retrying',
  ): Promise<any> {
    if (!Types.ObjectId.isValid(queueItemId)) {
      throw new NotFoundException('Assignment queue item not found');
    }
    const operationId = randomUUID();
    const visibleGroupIds = this.cls.get<string[] | null>('visibleGroupIds');
    const visibilityFilter =
      visibleGroupIds === null
        ? {}
        : { groupId: { $in: visibleGroupIds ?? [] } };
    const item = await this.queue
      .findOneAndUpdate(
        {
          _id: queueItemId,
          tenantId,
          status: 'queued',
          ...visibilityFilter,
        },
        {
          $set: {
            status,
            operationId,
            operationStartedAt: new Date(),
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!item) {
      const exists = await this.queue.exists({
        _id: queueItemId,
        tenantId,
        ...visibilityFilter,
      });
      if (!exists) {
        throw new NotFoundException('Assignment queue item not found');
      }
      throw new ConflictException(
        'Assignment queue item is already being processed',
      );
    }
    return item;
  }

  private async release(id: unknown, operationId: string): Promise<void> {
    await this.queue
      .updateOne(
        { _id: id, operationId },
        {
          $set: { status: 'queued', lastAttemptAt: new Date() },
          $unset: { operationId: 1, operationStartedAt: 1 },
          $inc: { attemptCount: 1 },
        },
      )
      .exec();
  }

  private async assertEligibleAssignee(
    tenantId: string,
    groupId: string,
    assigneeId: string,
  ): Promise<void> {
    if (
      !Types.ObjectId.isValid(tenantId) ||
      !Types.ObjectId.isValid(groupId) ||
      !Types.ObjectId.isValid(assigneeId)
    ) {
      throw new ConflictException('Queue assignee or scope is invalid');
    }
    const [user, group] = await Promise.all([
      this.connection.collection('users').findOne({
        _id: new Types.ObjectId(assigneeId),
        'tenants.tenantId': new Types.ObjectId(tenantId),
      }),
      this.connection.collection('groups').findOne({
        _id: new Types.ObjectId(groupId),
        tenantId: new Types.ObjectId(tenantId),
        $or: [
          { memberIds: new Types.ObjectId(assigneeId) },
          { memberIds: assigneeId },
          { members: new Types.ObjectId(assigneeId) },
          { members: assigneeId },
        ],
      }),
    ]);
    if (!user) {
      throw new ConflictException('Assignee is not a member of this workspace');
    }
    if (!group) {
      throw new ConflictException(
        'Assignee is not a member of the queue owning group',
      );
    }
  }

  private get tenantId(): string {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) throw new ConflictException('Tenant context is missing');
    return tenantId;
  }
}
