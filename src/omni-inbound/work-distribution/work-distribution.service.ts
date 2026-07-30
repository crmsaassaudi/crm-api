import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { ConversationCommandService } from '../aggregate/conversation-command.service';
import { OmniEvents } from '../domain/omni-events';
import { AgentPresenceService } from '../services/agent-presence.service';
import {
  QueueEntryDocument,
  QueueEntrySchemaClass,
  WorkItemDocument,
  WorkItemSchemaClass,
  WorkOfferDocument,
  WorkOfferSchemaClass,
} from './work-distribution.schema';
import {
  OmniConversationDocument,
  OmniConversationSchemaClass,
} from '../infrastructure/persistence/document/entities/omni-conversation.schema';
import {
  CapacityPolicyOverrides,
  mergeCapacityPolicies,
  normalizeCapacityPolicy,
  resolveAfterContactWorkSeconds,
  resolveCapacityWeight,
} from './capacity-policy';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import {
  InboxDocument,
  InboxSchemaClass,
} from '../../inboxes/infrastructure/inbox.schema';

@Injectable()
export class WorkDistributionService {
  constructor(
    @InjectModel(WorkItemSchemaClass.name)
    private readonly workItems: Model<WorkItemDocument>,
    @InjectModel(QueueEntrySchemaClass.name)
    private readonly queueEntries: Model<QueueEntryDocument>,
    @InjectModel(WorkOfferSchemaClass.name)
    private readonly offers: Model<WorkOfferDocument>,
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversations: Model<OmniConversationDocument>,
    @InjectModel(InboxSchemaClass.name)
    private readonly inboxes: Model<InboxDocument>,
    private readonly presence: AgentPresenceService,
    private readonly commands: ConversationCommandService,
    private readonly events: EventEmitter2,
    private readonly settings: CrmSettingsService,
  ) {}

  @OnEvent(OmniEvents.CONVERSATION_CREATED, { async: true })
  async onConversationCreated(event: any): Promise<void> {
    const conversation = event.conversation ?? {};
    const capacityPolicy = await this.resolveCapacityPolicy(
      event.tenantId,
      conversation.inboxId ?? event.inboxId ?? null,
    );
    const workItem = await this.workItems
      .findOneAndUpdate(
        {
          tenantId: event.tenantId,
          conversationId: event.conversationId,
        },
        {
          $setOnInsert: {
            tenantId: event.tenantId,
            conversationId: event.conversationId,
            inboxId: conversation.inboxId ?? event.inboxId ?? null,
            channelType: event.channelType ?? conversation.channelType,
            capacityWeight: resolveCapacityWeight(
              event.channelType ?? conversation.channelType,
              capacityPolicy.capacityWeights,
            ),
            status: conversation.assignedAgentId ? 'assigned' : 'queued',
            assignedAgentId: conversation.assignedAgentId ?? null,
            assignedAt: conversation.assignedAgentId ? new Date() : null,
          },
        },
        { upsert: true, new: true },
      )
      .exec();
    if (!workItem || conversation.assignedAgentId) return;
    await this.ensureQueueEntry(workItem);
  }

  @OnEvent(OmniEvents.CONVERSATION_ASSIGNED, { async: true })
  async onConversationAssigned(event: any): Promise<void> {
    const agentId = event.agentId ?? null;
    const workItem = await this.workItems
      .findOneAndUpdate(
        { tenantId: event.tenantId, conversationId: event.conversationId },
        {
          $set: {
            status: agentId ? 'assigned' : 'queued',
            assignedAgentId: agentId,
            assignedAt: agentId ? new Date() : null,
          },
        },
        { new: true },
      )
      .exec();
    if (!workItem) return;
    if (agentId) {
      await this.queueEntries
        .updateMany(
          {
            tenantId: event.tenantId,
            workItemId: workItem._id,
            status: { $in: ['waiting', 'offered'] },
          },
          { $set: { status: 'assigned', dequeuedAt: new Date() } },
        )
        .exec();
    } else {
      await this.ensureQueueEntry(workItem);
    }
  }

  @OnEvent(OmniEvents.CONVERSATION_STATUS_CHANGED, { async: true })
  async onConversationStatusChanged(event: any): Promise<void> {
    const status = event.newStatus ?? event.status;
    if (!['resolved', 'closed'].includes(status)) return;
    const now = new Date();
    const conversation = await this.conversations
      .findOne({
        _id: event.conversationId,
        tenantId: event.tenantId,
      })
      .select('channelType assignedAgentId inboxId')
      .lean()
      .exec();
    const capacityPolicy = await this.resolveCapacityPolicy(
      event.tenantId,
      conversation?.inboxId ?? event.inboxId ?? null,
    );
    const acwSeconds = resolveAfterContactWorkSeconds(
      conversation?.channelType ?? event.channelType ?? 'unknown',
      capacityPolicy.afterContactWorkSeconds,
    );
    const assignedAgentId = conversation?.assignedAgentId ?? null;
    const item = await this.workItems
      .findOneAndUpdate(
        {
          tenantId: event.tenantId,
          conversationId: event.conversationId,
          status: { $in: ['queued', 'offered', 'assigned', 'active'] },
        },
        assignedAgentId && acwSeconds > 0
          ? {
              $set: {
                status: 'wrap_up',
                assignedAgentId,
                wrapUpStartedAt: now,
                wrapUpDueAt: new Date(now.getTime() + acwSeconds * 1000),
              },
            }
          : {
              $set: {
                status: 'completed',
                completedAt: now,
                capacityReleasedAt: assignedAgentId ? now : null,
              },
            },
        { new: true },
      )
      .exec();
    if (!item) return;
    await this.queueEntries
      .updateMany(
        {
          tenantId: event.tenantId,
          workItemId: item._id,
          status: { $in: ['waiting', 'offered'] },
        },
        { $set: { status: 'cancelled', dequeuedAt: new Date() } },
      )
      .exec();
    const reservedAgentId = item.assignedAgentId
      ? String(item.assignedAgentId)
      : null;
    if (!assignedAgentId && reservedAgentId) {
      await this.offers
        .updateMany(
          {
            tenantId: event.tenantId,
            workItemId: item._id,
            status: 'offered',
          },
          { $set: { status: 'cancelled', respondedAt: now } },
        )
        .exec();
      await this.workItems
        .updateOne(
          { _id: item._id, capacityReleasedAt: null },
          { $set: { capacityReleasedAt: now } },
        )
        .exec();
      await this.presence.releaseConversation(
        event.tenantId,
        reservedAgentId,
        item.capacityWeight,
      );
    }
    if (assignedAgentId && acwSeconds === 0) {
      await this.presence.releaseConversation(
        event.tenantId,
        String(assignedAgentId),
        item.capacityWeight,
      );
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async completeDueWrapUp(): Promise<number> {
    const candidates = await this.workItems
      .find({ status: 'wrap_up', wrapUpDueAt: { $lte: new Date() } })
      .select('_id tenantId assignedAgentId')
      .sort({ wrapUpDueAt: 1, _id: 1 })
      .limit(500)
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();
    let completed = 0;
    for (const candidate of candidates) {
      const now = new Date();
      const item = await this.workItems
        .findOneAndUpdate(
          {
            _id: candidate._id,
            status: 'wrap_up',
            capacityReleasedAt: null,
          },
          {
            $set: {
              status: 'completed',
              completedAt: now,
              capacityReleasedAt: now,
            },
          },
          { new: true },
        )
        .setOptions({ isPlatformQuery: true })
        .exec();
      if (!item) continue;
      if (item.assignedAgentId) {
        await this.presence.releaseConversation(
          String(item.tenantId),
          String(item.assignedAgentId),
          item.capacityWeight,
        );
      }
      this.events.emit('omni.work_item.wrap_up_completed', {
        tenantId: String(item.tenantId),
        workItemId: String(item._id),
        conversationId: String(item.conversationId),
        agentId: item.assignedAgentId ? String(item.assignedAgentId) : null,
      });
      completed++;
    }
    return completed;
  }

  async createOffer(params: {
    tenantId: string;
    workItemId: string;
    agentId: string;
    leaseMs?: number;
    capacityWeight?: number;
  }): Promise<any> {
    const reserved = await this.presence.reserveFirstEligibleAgent(
      params.tenantId,
      [params.agentId],
      params.capacityWeight,
    );
    if (reserved !== params.agentId) {
      throw new ConflictException('Agent is not eligible or has no capacity');
    }

    let claimedWorkItem: WorkItemDocument | null = null;
    let claimedQueueEntry: QueueEntryDocument | null = null;
    try {
      claimedWorkItem = await this.workItems
        .findOneAndUpdate(
          {
            _id: params.workItemId,
            tenantId: params.tenantId,
            status: 'queued',
          },
          {
            $set: {
              status: 'offered',
              assignedAgentId: params.agentId,
            },
          },
          { new: true },
        )
        .exec();
      if (!claimedWorkItem)
        throw new ConflictException('Work item is not queued');

      claimedQueueEntry = await this.queueEntries
        .findOneAndUpdate(
          {
            tenantId: params.tenantId,
            workItemId: claimedWorkItem._id,
            status: 'waiting',
          },
          { $set: { status: 'offered', offeredAt: new Date() } },
          { new: true },
        )
        .exec();
      if (!claimedQueueEntry) {
        await this.workItems
          .updateOne(
            { _id: claimedWorkItem._id, status: 'offered' },
            {
              $set: {
                status: 'queued',
                assignedAgentId: null,
              },
            },
          )
          .exec();
        throw new ConflictException('Queue entry is not available');
      }

      return await this.offers.create({
        tenantId: params.tenantId,
        workItemId: claimedWorkItem._id,
        queueEntryId: claimedQueueEntry._id,
        agentId: params.agentId,
        status: 'offered',
        capacityWeight:
          claimedWorkItem.capacityWeight ?? params.capacityWeight ?? 1,
        expiresAt: new Date(Date.now() + (params.leaseMs ?? 30_000)),
      });
    } catch (error) {
      if (claimedQueueEntry) {
        await this.queueEntries
          .updateOne(
            { _id: claimedQueueEntry._id, status: 'offered' },
            { $set: { status: 'waiting', offeredAt: null } },
          )
          .exec();
      }
      if (claimedWorkItem) {
        await this.workItems
          .updateOne(
            { _id: claimedWorkItem._id, status: 'offered' },
            {
              $set: {
                status: 'queued',
                assignedAgentId: null,
              },
            },
          )
          .exec();
      }
      await this.presence.releaseConversation(
        params.tenantId,
        params.agentId,
        params.capacityWeight,
      );
      throw error;
    }
  }

  /**
   * Commit hook for AssignmentCore after it has already reserved capacity.
   * It must never reserve again; doing so would consume two slots for one
   * offer. Returning false asks the core to release its reservation.
   */
  async createOfferFromReservation(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    groupId: string | null;
    leaseMs?: number;
  }): Promise<boolean> {
    const conversation = await this.conversations
      .findOne({
        _id: params.conversationId,
        tenantId: params.tenantId,
        status: { $in: ['open', 'pending'] },
        assignedAgentId: null,
      })
      .lean()
      .exec();
    if (!conversation) return false;
    const capacityPolicy = await this.resolveCapacityPolicy(
      params.tenantId,
      conversation.inboxId ?? null,
    );

    let workItem: WorkItemDocument | null;
    try {
      workItem = await this.workItems
        .findOneAndUpdate(
          {
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            status: { $in: ['queued', 'offered'] },
          },
          {
            $setOnInsert: {
              tenantId: params.tenantId,
              conversationId: params.conversationId,
              inboxId: conversation.inboxId ?? null,
              channelType: conversation.channelType,
              priority: 0,
              capacityWeight: resolveCapacityWeight(
                conversation.channelType,
                capacityPolicy.capacityWeights,
              ),
            },
            $set: {
              status: 'offered',
              owningGroupId: params.groupId,
              assignedAgentId: params.agentId,
            },
          },
          { upsert: true, new: true },
        )
        .exec();
    } catch (error: any) {
      if (error?.code === 11000) return false;
      throw error;
    }
    if (!workItem) return false;

    await this.ensureQueueEntry(workItem);
    const queueEntry = await this.queueEntries
      .findOneAndUpdate(
        {
          tenantId: params.tenantId,
          workItemId: workItem._id,
          status: 'waiting',
        },
        { $set: { status: 'offered', offeredAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!queueEntry) {
      await this.workItems
        .updateOne(
          { _id: workItem._id, status: 'offered' },
          { $set: { status: 'queued', assignedAgentId: null } },
        )
        .exec();
      return false;
    }

    try {
      const offer = await this.offers.create({
        tenantId: params.tenantId,
        workItemId: workItem._id,
        queueEntryId: queueEntry._id,
        agentId: params.agentId,
        status: 'offered',
        capacityWeight: workItem.capacityWeight ?? 1,
        expiresAt: new Date(Date.now() + (params.leaseMs ?? 30_000)),
      });
      this.events.emit(OmniEvents.WORK_OFFER_CREATED, {
        tenantId: params.tenantId,
        conversationId: params.conversationId,
        workItemId: String(workItem._id),
        offerId: String(offer._id),
        agentId: params.agentId,
        groupId: params.groupId,
        expiresAt: offer.expiresAt,
      });
      return true;
    } catch {
      await this.queueEntries
        .updateOne(
          { _id: queueEntry._id, status: 'offered' },
          { $set: { status: 'waiting', offeredAt: null } },
        )
        .exec();
      await this.workItems
        .updateOne(
          { _id: workItem._id, status: 'offered' },
          { $set: { status: 'queued', assignedAgentId: null } },
        )
        .exec();
      return false;
    }
  }

  async acceptOffer(
    tenantId: string,
    offerId: string,
    agentId: string,
  ): Promise<any> {
    const offer = await this.offers
      .findOneAndUpdate(
        {
          _id: offerId,
          tenantId,
          agentId,
          status: 'offered',
          expiresAt: { $gt: new Date() },
        },
        { $set: { status: 'accepted', respondedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!offer) throw new ConflictException('Offer is unavailable or expired');

    const item = await this.workItems
      .findOneAndUpdate(
        { _id: offer.workItemId, tenantId, status: 'offered' },
        {
          $set: {
            status: 'assigned',
            assignedAgentId: agentId,
            assignedAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();
    if (!item) {
      await this.offers
        .updateOne(
          { _id: offer._id, status: 'accepted' },
          { $set: { status: 'cancelled' } },
        )
        .exec();
      await this.presence.releaseConversation(
        tenantId,
        agentId,
        offer.capacityWeight,
      );
      throw new ConflictException('Work item is no longer offered');
    }

    try {
      const assigned = await this.commands.executeAssignAgent(
        String(item.conversationId),
        tenantId,
        {
          agentId,
          onlyIfUnassigned: true,
          reason: 'offer_accepted',
        },
      );
      if (String(assigned?.assignedAgentId ?? '') !== agentId) {
        throw new ConflictException(
          'Conversation was claimed by another agent',
        );
      }
      await this.queueEntries
        .updateOne(
          { _id: offer.queueEntryId, tenantId, status: 'offered' },
          { $set: { status: 'assigned', dequeuedAt: new Date() } },
        )
        .exec();
    } catch (error) {
      await this.offers
        .updateOne(
          { _id: offer._id, status: 'accepted' },
          { $set: { status: 'cancelled' } },
        )
        .exec();
      await this.workItems
        .updateOne(
          { _id: item._id, status: 'assigned', assignedAgentId: agentId },
          {
            $set: {
              status: 'queued',
              assignedAgentId: null,
              assignedAt: null,
            },
          },
        )
        .exec();
      await this.queueEntries
        .updateOne(
          { _id: offer.queueEntryId, status: 'offered' },
          { $set: { status: 'waiting', offeredAt: null } },
        )
        .exec();
      await this.presence.releaseConversation(
        tenantId,
        agentId,
        offer.capacityWeight,
      );
      throw error;
    }
    return { offerId, workItemId: String(item._id), status: 'accepted' };
  }

  async declineOffer(
    tenantId: string,
    offerId: string,
    agentId: string,
    reason?: string,
  ): Promise<any> {
    const offer = await this.offers
      .findOneAndUpdate(
        { _id: offerId, tenantId, agentId, status: 'offered' },
        {
          $set: {
            status: 'declined',
            respondedAt: new Date(),
            declineReason: reason ?? null,
          },
        },
        { new: true },
      )
      .exec();
    if (!offer) throw new NotFoundException('Open offer not found');
    await this.returnToQueue(offer);
    await this.presence.releaseConversation(
      tenantId,
      agentId,
      offer.capacityWeight,
    );
    return { offerId, status: 'declined' };
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async expireOffers(): Promise<number> {
    const expired = await this.offers
      .find({ status: 'offered', expiresAt: { $lte: new Date() } })
      .select('_id tenantId agentId workItemId queueEntryId')
      .limit(200)
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();
    let count = 0;
    for (const candidate of expired) {
      const result = await this.offers
        .findOneAndUpdate(
          { _id: candidate._id, status: 'offered' },
          { $set: { status: 'expired', respondedAt: new Date() } },
          { new: true },
        )
        .setOptions({ isPlatformQuery: true })
        .exec();
      if (!result) continue;
      await this.returnToQueue(result, true);
      await this.presence.releaseConversation(
        String(result.tenantId),
        String(result.agentId),
        result.capacityWeight,
      );
      count++;
    }
    return count;
  }

  /**
   * EventEmitter is a low-latency projection trigger, not a durability
   * boundary. Repair recent conversations whose process stopped between the
   * Conversation write and WorkItem creation. Historical rows are handled by
   * the deployment backfill.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileRecentWorkItems(): Promise<number> {
    const missing = await this.conversations
      .aggregate([
        {
          $match: {
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60_000) },
            status: { $in: ['open', 'pending'] },
          },
        },
        {
          $lookup: {
            from: 'omni_work_items',
            localField: '_id',
            foreignField: 'conversationId',
            as: 'workItems',
          },
        },
        { $match: { workItems: { $eq: [] } } },
        { $sort: { createdAt: 1, _id: 1 } },
        { $limit: 200 },
        {
          $project: {
            _id: 1,
            tenantId: 1,
            inboxId: 1,
            channelType: 1,
            assignedAgentId: 1,
          },
        },
      ])
      .option({ isPlatformQuery: true })
      .exec();

    for (const conversation of missing) {
      await this.onConversationCreated({
        tenantId: String(conversation.tenantId),
        conversationId: String(conversation._id),
        channelType: conversation.channelType,
        conversation,
      });
    }
    return missing.length;
  }

  private async ensureQueueEntry(workItem: WorkItemDocument): Promise<void> {
    await this.queueEntries
      .findOneAndUpdate(
        {
          tenantId: workItem.tenantId,
          workItemId: workItem._id,
          status: { $in: ['waiting', 'offered'] },
        },
        {
          $setOnInsert: {
            tenantId: workItem.tenantId,
            workItemId: workItem._id,
            inboxId: workItem.inboxId ?? null,
            status: 'waiting',
            basePriority: workItem.priority ?? 0,
            queuedAt: new Date(),
          },
        },
        { upsert: true },
      )
      .exec();
  }

  private async returnToQueue(
    offer: WorkOfferDocument,
    platformQuery = false,
  ): Promise<void> {
    await this.workItems
      .updateOne(
        { _id: offer.workItemId, status: 'offered' },
        { $set: { status: 'queued', assignedAgentId: null, assignedAt: null } },
      )
      .setOptions(platformQuery ? { isPlatformQuery: true } : {})
      .exec();
    await this.queueEntries
      .updateOne(
        { _id: offer.queueEntryId, status: 'offered' },
        { $set: { status: 'waiting', offeredAt: null } },
      )
      .setOptions(platformQuery ? { isPlatformQuery: true } : {})
      .exec();
  }

  private async resolveCapacityPolicy(
    tenantId: string,
    inboxId?: string | null,
  ): Promise<CapacityPolicyOverrides> {
    let tenantPolicy: CapacityPolicyOverrides = {};
    try {
      tenantPolicy = normalizeCapacityPolicy(
        await this.settings.getSetting('omni_capacity', tenantId),
      );
    } catch {
      tenantPolicy = {};
    }

    if (!inboxId) return tenantPolicy;

    const inbox = await this.inboxes
      .findOne({ _id: inboxId, tenantId })
      .select('capacityPolicy')
      .lean()
      .exec();

    return mergeCapacityPolicies(
      tenantPolicy,
      normalizeCapacityPolicy(inbox?.capacityPolicy),
    );
  }
}
