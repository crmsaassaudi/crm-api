import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import {
  AssignDecision,
  AssignRequest,
  AssignmentCoreService,
} from '../core/assignment-core.service';
import {
  AssignmentCommandDocument,
  AssignmentCommandSchemaClass,
} from '../infrastructure/persistence/assignment-command.schema';
import {
  AssignmentOutboxEventDocument,
  AssignmentOutboxEventSchemaClass,
} from '../infrastructure/persistence/assignment-outbox-event.schema';

@Injectable()
export class AssignmentCommandService {
  constructor(
    @InjectModel(AssignmentCommandSchemaClass.name)
    private readonly commands: Model<AssignmentCommandDocument>,
    @InjectModel(AssignmentOutboxEventSchemaClass.name)
    private readonly outbox: Model<AssignmentOutboxEventDocument>,
    private readonly core: AssignmentCoreService,
    private readonly cls: ClsService,
  ) {}

  async execute(
    idempotencyKey: string,
    request: AssignRequest & { entityId: string },
  ): Promise<AssignDecision> {
    const existing = await this.commands
      .findOne({ tenantId: request.tenantId, idempotencyKey })
      .lean()
      .exec();
    if (existing?.status === 'completed' && existing.decision) {
      return existing.decision as unknown as AssignDecision;
    }
    if (existing?.status === 'processing') {
      throw new ConflictException('Assignment command is already processing');
    }

    let command: any;
    if (existing) {
      command = await this.commands
        .findOneAndUpdate(
          {
            _id: existing._id,
            status: 'failed',
          },
          {
            $set: {
              status: 'processing',
              request: this.requestSnapshot(request),
              error: null,
            },
          },
          { new: true },
        )
        .lean()
        .exec();
    } else {
      try {
        command = await this.commands.create({
          tenantId: request.tenantId,
          idempotencyKey,
          objectType: request.objectType,
          entityId: request.entityId,
          status: 'processing',
          request: this.requestSnapshot(request),
        });
      } catch (error: any) {
        if (error?.code === 11000) {
          throw new ConflictException(
            'Assignment command was concurrently created',
          );
        }
        throw error;
      }
    }
    if (!command) {
      throw new ConflictException('Assignment command retry lost its race');
    }
    const commandId = String(command._id);

    try {
      const decision = await this.core.assign({ ...request, commandId });
      await this.completeWithOutbox(commandId, request, decision);
      return decision;
    } catch (error: any) {
      await this.commands.updateOne(
        { _id: commandId, status: 'processing' },
        { $set: { status: 'failed', error: error.message } },
      );
      throw error;
    }
  }

  private async completeWithOutbox(
    commandId: string,
    request: AssignRequest & { entityId: string },
    decision: AssignDecision,
  ): Promise<void> {
    const session = await this.commands.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.commands.updateOne(
          { _id: commandId, status: 'processing' },
          {
            $set: {
              status: 'completed',
              decision,
              completedAt: new Date(),
            },
          },
          { session },
        );
        await this.outbox.updateOne(
          { tenantId: request.tenantId, eventId: `${commandId}:decided` },
          {
            $setOnInsert: {
              tenantId: request.tenantId,
              eventId: `${commandId}:decided`,
              eventType: 'assignment.decided',
              aggregateId: request.entityId,
              payload: {
                commandId,
                tenantId: request.tenantId,
                objectType: request.objectType,
                entityId: request.entityId,
                decision,
              },
              status: 'pending',
              retryCount: 0,
            },
          },
          { upsert: true, session },
        );
      });
    } finally {
      await session.endSession();
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async recoverStaleCommands(): Promise<number> {
    const stale = await this.commands
      .find({
        status: 'processing',
        updatedAt: { $lt: new Date(Date.now() - 2 * 60_000) },
      })
      .limit(50)
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();
    let recovered = 0;
    for (const command of stale) {
      const claimed = await this.commands
        .findOneAndUpdate(
          { _id: command._id, status: 'processing' },
          {
            $set: {
              status: 'failed',
              error: 'Recovered stale processing command',
            },
          },
          { new: true },
        )
        .setOptions({ isPlatformQuery: true })
        .lean()
        .exec();
      if (!claimed) continue;
      try {
        await runWithTenantContext(this.cls, String(command.tenantId), () =>
          this.execute(
            command.idempotencyKey,
            command.request as AssignRequest & { entityId: string },
          ),
        );
        recovered++;
      } catch {
        // execute() persisted the latest failure; the next run may retry it.
      }
    }
    return recovered;
  }

  private requestSnapshot(request: AssignRequest): Record<string, any> {
    const { commit: _commit, ...serialisable } = request;
    return serialisable;
  }
}
