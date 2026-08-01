import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ChannelSupportService } from '../../channels/services/channel-support.service';
import { ConversationCommandService } from '../aggregate/conversation-command.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { AgentPresenceService } from '../services/agent-presence.service';
import {
  ConversationTransferDocument,
  ConversationTransferSchemaClass,
} from './conversation-transfer.schema';
import { CreateTransferDto } from './transfer.dto';
import { resolveCapacityWeight } from '../work-distribution/capacity-policy';
import { RedisLockService } from '../../redis/redis-lock.service';
import { runAsClusterSingleton } from '../../common/scheduling/cluster-singleton';

@Injectable()
export class ConversationTransferService {
  private readonly logger = new Logger(ConversationTransferService.name);

  constructor(
    @InjectModel(ConversationTransferSchemaClass.name)
    private readonly transfers: Model<ConversationTransferDocument>,
    private readonly conversations: ConversationRepository,
    private readonly commands: ConversationCommandService,
    private readonly presence: AgentPresenceService,
    private readonly channelSupport: ChannelSupportService,
    private readonly events: EventEmitter2,
    private readonly lockService: RedisLockService,
  ) {}

  async create(
    tenantId: string,
    conversationId: string,
    actorId: string,
    dto: CreateTransferDto,
  ): Promise<any> {
    if (actorId === dto.targetAgentId) {
      throw new ConflictException('Source and target agent must differ');
    }
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation || conversation.tenantId !== tenantId) {
      throw new NotFoundException('Conversation not found');
    }
    if (String(conversation.assignedAgentId ?? '') !== actorId) {
      throw new ForbiddenException(
        'Only the current assignee can initiate a transfer',
      );
    }
    await this.channelSupport.assertAgentEligible(
      tenantId,
      String(conversation.channelId),
      dto.targetAgentId,
    );

    const transfer = await this.transfers.create({
      tenantId,
      conversationId,
      type: dto.type,
      sourceAgentId: actorId,
      targetAgentId: dto.targetAgentId,
      targetGroupId: dto.targetGroupId ?? null,
      status: dto.type === 'cold' ? 'accepted' : 'requested',
      reason: dto.reason ?? null,
      handoffNote: dto.handoffNote ?? null,
      expiresAt: new Date(Date.now() + 5 * 60_000),
      respondedAt: dto.type === 'cold' ? new Date() : null,
      capacityWeight: resolveCapacityWeight(conversation.channelType),
    });

    if (dto.type === 'cold') {
      try {
        await this.commitOwnership(transfer, conversation.channelType);
        transfer.status = 'completed';
        transfer.completedAt = new Date();
        await transfer.save();
      } catch (error) {
        transfer.status = 'cancelled';
        transfer.completedAt = new Date();
        await transfer.save();
        throw error;
      }
    }
    this.emitChanged(transfer);
    return transfer;
  }

  async accept(
    tenantId: string,
    transferId: string,
    actorId: string,
  ): Promise<any> {
    const transfer = await this.transfers
      .findOneAndUpdate(
        {
          _id: transferId,
          tenantId,
          targetAgentId: actorId,
          status: 'requested',
          expiresAt: { $gt: new Date() },
        },
        {
          $set: {
            status: 'accepted',
            respondedAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();
    if (!transfer) {
      throw new ConflictException('Transfer is unavailable or expired');
    }

    const reserved = await this.presence.claimIfUnderCapacity(
      tenantId,
      actorId,
      transfer.capacityWeight,
    );
    if (!reserved) {
      await this.transfers
        .updateOne(
          { _id: transfer._id, status: 'accepted' },
          { $set: { status: 'requested', respondedAt: null } },
        )
        .exec();
      throw new ConflictException('Target agent has no available capacity');
    }

    try {
      if (transfer.type === 'warm') {
        const conversation = await this.conversations.findById(
          String(transfer.conversationId),
        );
        await this.commitOwnership(
          transfer,
          conversation?.channelType ?? 'unknown',
          true,
        );
        transfer.status = 'completed';
        transfer.completedAt = new Date();
      } else {
        transfer.status = 'consulting';
        transfer.consultCapacityReserved = true;
        transfer.expiresAt = new Date(Date.now() + 30 * 60_000);
      }
      await transfer.save();
      this.emitChanged(transfer);
      return transfer;
    } catch (error) {
      await this.presence.releaseConversation(
        tenantId,
        actorId,
        transfer.capacityWeight,
      );
      transfer.status = 'cancelled';
      transfer.completedAt = new Date();
      await transfer.save();
      throw error;
    }
  }

  async reject(
    tenantId: string,
    transferId: string,
    actorId: string,
    reason?: string,
  ): Promise<any> {
    const transfer = await this.transfers
      .findOneAndUpdate(
        {
          _id: transferId,
          tenantId,
          targetAgentId: actorId,
          status: 'requested',
        },
        {
          $set: {
            status: 'rejected',
            respondedAt: new Date(),
            reason: reason ?? null,
          },
        },
        { new: true },
      )
      .exec();
    if (!transfer) throw new NotFoundException('Open transfer not found');
    this.emitChanged(transfer);
    return transfer;
  }

  async cancel(
    tenantId: string,
    transferId: string,
    actorId: string,
  ): Promise<any> {
    const transfer = await this.transfers
      .findOneAndUpdate(
        {
          _id: transferId,
          tenantId,
          sourceAgentId: actorId,
          status: { $in: ['requested', 'consulting'] },
        },
        {
          $set: {
            status: 'cancelled',
            completedAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();
    if (!transfer) throw new NotFoundException('Open transfer not found');
    if (transfer.consultCapacityReserved) {
      await this.presence.releaseConversation(
        tenantId,
        String(transfer.targetAgentId),
        transfer.capacityWeight,
      );
    }
    this.emitChanged(transfer);
    return transfer;
  }

  async completeConsult(
    tenantId: string,
    transferId: string,
    actorId: string,
    transferOwnership: boolean,
  ): Promise<any> {
    const transfer = await this.transfers
      .findOne({
        _id: transferId,
        tenantId,
        sourceAgentId: actorId,
        type: 'consult',
        status: 'consulting',
      })
      .exec();
    if (!transfer) throw new NotFoundException('Active consult not found');

    if (transferOwnership) {
      const conversation = await this.conversations.findById(
        String(transfer.conversationId),
      );
      await this.commitOwnership(
        transfer,
        conversation?.channelType ?? 'unknown',
        true,
      );
      // The consult reservation becomes the new owner's active workload.
      transfer.consultCapacityReserved = false;
    } else if (transfer.consultCapacityReserved) {
      await this.presence.releaseConversation(
        tenantId,
        String(transfer.targetAgentId),
        transfer.capacityWeight,
      );
      transfer.consultCapacityReserved = false;
    }
    transfer.status = 'completed';
    transfer.completedAt = new Date();
    await transfer.save();
    this.emitChanged(transfer);
    return transfer;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expirePendingTick(): Promise<void> {
    await runAsClusterSingleton(
      { lockService: this.lockService, logger: this.logger },
      { name: 'omni:transfer:expire-pending', lockTtlMs: 2 * 60_000 },
      () => this.expirePending(),
    );
  }

  async expirePending(): Promise<number> {
    const candidates = await this.transfers
      .find({
        status: { $in: ['requested', 'consulting'] },
        expiresAt: { $lte: new Date() },
      })
      .select('_id tenantId targetAgentId consultCapacityReserved')
      .limit(200)
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();
    let count = 0;
    for (const item of candidates) {
      const result = await this.transfers
        .findOneAndUpdate(
          { _id: item._id, status: { $in: ['requested', 'consulting'] } },
          { $set: { status: 'expired', completedAt: new Date() } },
          { new: true },
        )
        .setOptions({ isPlatformQuery: true })
        .exec();
      if (result) {
        if (result.consultCapacityReserved) {
          await this.presence.releaseConversation(
            String(result.tenantId),
            String(result.targetAgentId),
            result.capacityWeight,
          );
        }
        this.emitChanged(result);
        count++;
      }
    }
    return count;
  }

  @OnEvent('omni.conversation.status_changed', { async: true })
  async onConversationStatusChanged(event: any): Promise<void> {
    if (!['resolved', 'closed'].includes(event.newStatus ?? event.status))
      return;
    const open = await this.transfers
      .find({
        tenantId: event.tenantId,
        conversationId: event.conversationId,
        status: { $in: ['requested', 'consulting', 'accepted'] },
      })
      .exec();
    for (const transfer of open) {
      const wasReserved = transfer.consultCapacityReserved;
      transfer.status = 'cancelled';
      transfer.completedAt = new Date();
      transfer.consultCapacityReserved = false;
      await transfer.save();
      if (wasReserved) {
        await this.presence.releaseConversation(
          event.tenantId,
          String(transfer.targetAgentId),
          transfer.capacityWeight,
        );
      }
      this.emitChanged(transfer);
    }
  }

  private async commitOwnership(
    transfer: ConversationTransferDocument,
    channelType: string,
    capacityAlreadyReserved = false,
  ): Promise<void> {
    const tenantId = String(transfer.tenantId);
    const targetId = String(transfer.targetAgentId);
    const sourceId = String(transfer.sourceAgentId);
    if (!capacityAlreadyReserved) {
      const reserved = await this.presence.claimIfUnderCapacity(
        tenantId,
        targetId,
        transfer.capacityWeight,
      );
      if (!reserved) throw new ConflictException('Target agent is at capacity');
    }
    try {
      const updated = await this.commands.executeAssignAgent(
        String(transfer.conversationId),
        tenantId,
        {
          agentId: targetId,
          groupId: transfer.targetGroupId
            ? String(transfer.targetGroupId)
            : undefined,
          previousAgentId: sourceId,
          performedByUserId: sourceId,
          reason: `transfer_${transfer.type}`,
          syncCapacity: {
            releaseAgentId: sourceId,
            releaseWeight: transfer.capacityWeight,
          },
          auditLog: { channelType },
        },
      );
      if (String(updated?.assignedAgentId ?? '') !== targetId) {
        throw new ConflictException('Conversation ownership changed');
      }
    } catch (error) {
      if (!capacityAlreadyReserved) {
        await this.presence.releaseConversation(
          tenantId,
          targetId,
          transfer.capacityWeight,
        );
      }
      throw error;
    }
  }

  private emitChanged(transfer: ConversationTransferDocument): void {
    this.events.emit('omni.transfer.changed', {
      tenantId: String(transfer.tenantId),
      transferId: String(transfer._id),
      conversationId: String(transfer.conversationId),
      type: transfer.type,
      status: transfer.status,
      sourceAgentId: String(transfer.sourceAgentId),
      targetAgentId: String(transfer.targetAgentId),
      handoffNote: transfer.handoffNote,
      expiresAt: transfer.expiresAt,
    });
  }
}
