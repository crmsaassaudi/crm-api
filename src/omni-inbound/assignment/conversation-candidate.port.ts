import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import {
  AssignmentScope,
  CandidateSourcePort,
} from '../../assignment/core/ports';
import { AgentPresenceService } from '../services/agent-presence.service';
import { ChannelSupportService } from '../../channels/services/channel-support.service';
import { ConversationRepository } from '../repositories/conversation.repository';

/**
 * Candidate resolution for conversations: the channel's support pool,
 * intersected with who is actually online.
 *
 * The intersection is done here rather than in the core because it is the whole
 * definition of "who may take this conversation" for omni, and because the two
 * inputs — an admin-configured access list and a live presence set — have very
 * different failure modes.
 */
@Injectable()
export class ConversationCandidatePort implements CandidateSourcePort {
  private readonly logger = new Logger(ConversationCandidatePort.name);

  constructor(
    private readonly presence: AgentPresenceService,
    private readonly channelSupport: ChannelSupportService,
    private readonly conversationRepo: ConversationRepository,
    @InjectModel('GroupSchemaClass') private readonly groupModel: Model<any>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /**
   * Resolve the channel id for a decision.
   *
   * `scopeId` carries it on the inbound path. When it is absent — the sticky
   * retry and offline-reassign processors call assignment with only a
   * conversation id — it is read from the conversation.
   *
   * This is a security fix, not a convenience: those two paths previously
   * reached the strategy with no channel context at all, so the support pool
   * was not applied and an agent outside a restricted channel could be handed
   * its conversations on retry.
   */
  private async channelIdFor(scope: AssignmentScope): Promise<string | null> {
    if (scope.scopeId) return String(scope.scopeId);
    if (!scope.entityId) return null;
    try {
      const conversation: any = await this.conversationRepo.findById(
        scope.entityId,
      );
      return conversation?.channelId ? String(conversation.channelId) : null;
    } catch (err: any) {
      this.logger.warn(
        `Could not resolve the channel of conversation ${scope.entityId}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * `channel support pool ∩ online agents`.
   *
   * `undefined` when the channel is unrestricted → every online agent qualifies.
   * `[]` when a pool was resolved and nobody in it is online → the conversation
   * queues. Conflating those two is how a restricted channel ended up routing
   * over the whole tenant.
   */
  async basePool(scope: AssignmentScope): Promise<string[] | undefined> {
    const channelId = await this.channelIdFor(scope);

    let poolAgentIds: string[] | null = null;
    if (channelId) {
      try {
        poolAgentIds = await this.channelSupport.resolveEligibleAgents(
          scope.tenantId,
          channelId,
        );
      } catch (err: any) {
        // Fail CLOSED on the access list: if we cannot tell who is allowed to
        // serve a restricted channel, queueing is correct and assigning to
        // everyone is not.
        this.logger.error(
          `Failed to resolve the support pool of channel ${channelId}: ${err.message} — queueing`,
        );
        return [];
      }
    }

    let online: string[];
    try {
      online = await this.presence.getOnlineAgents(scope.tenantId);
    } catch (err: any) {
      // No presence means nobody is known to be available. Queueing keeps the
      // conversation visible; assigning it to an agent we cannot confirm is
      // online would silently strand the customer.
      this.logger.error(
        `Failed to read presence for tenant ${scope.tenantId}: ${err.message} — queueing`,
      );
      return [];
    }

    if (poolAgentIds === null) return online;
    const allowed = new Set(poolAgentIds.map(String));
    return online.filter((id) => allowed.has(String(id)));
  }

  async groupMembers(
    _scope: AssignmentScope,
    groupIds: string[],
  ): Promise<string[]> {
    const ids = groupIds.filter((id) => Types.ObjectId.isValid(id));
    if (ids.length === 0) return [];
    try {
      const groups = await this.groupModel
        .find({ _id: { $in: ids } })
        .select({ memberIds: 1 })
        .lean()
        .exec();
      const members = groups.flatMap((g: any) =>
        (g.memberIds ?? g.members ?? []).map(String),
      );
      return [...new Set(members)];
    } catch (err: any) {
      this.logger.warn(
        `Failed to resolve members of group(s) ${ids.join(', ')}: ${err.message}`,
      );
      return [];
    }
  }

  /**
   * Whether a team may serve this conversation's channel.
   *
   * A rule is configured independently of any channel and can perfectly well
   * name a team with no business serving it; the core skips such a tier rather
   * than honouring it.
   */
  async groupMayServe(
    scope: AssignmentScope,
    groupId: string,
  ): Promise<boolean> {
    const channelId = await this.channelIdFor(scope);
    if (!channelId) return true;
    try {
      await this.channelSupport.assertGroupEligible(
        scope.tenantId,
        channelId,
        groupId,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Skills, presence-first.
   *
   * Presence hydrates `skills` at connect and on user update, so a warm pool
   * costs zero database reads. Only candidates missing from presence fall back
   * to the users collection, in one batched read.
   */
  async skills(
    scope: AssignmentScope,
    candidateIds: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const missing: string[] = [];

    await Promise.all(
      candidateIds.map(async (id) => {
        try {
          const presence = await this.presence.getPresence(scope.tenantId, id);
          if (presence?.skills !== undefined) {
            result.set(id, presence.skills.map(String));
          } else {
            missing.push(id);
          }
        } catch {
          missing.push(id);
        }
      }),
    );

    if (missing.length > 0) {
      const ids = missing
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      if (ids.length > 0) {
        try {
          // Raw driver call — bypasses the Mongoose model's tenantFilterPlugin,
          // unlike groupMembers() above. Explicit filter needed here (mirrors
          // record-candidate.port.ts's fix for the same gap): without it, a
          // candidate id that falls through to this fallback (cold/evicted
          // presence cache) could disclose another tenant's user data.
          const users = await this.connection
            .collection('users')
            .find({
              _id: { $in: ids },
              'tenants.tenantId': Types.ObjectId.isValid(scope.tenantId)
                ? new Types.ObjectId(scope.tenantId)
                : scope.tenantId,
            })
            .project({ _id: 1, skills: 1 })
            .toArray();
          for (const user of users) {
            result.set(
              String(user._id),
              Array.isArray(user.skills) ? user.skills.map(String) : [],
            );
          }
        } catch (err: any) {
          this.logger.error(
            `Failed to read skills for un-hydrated candidates: ${err.message}`,
          );
        }
      }
    }

    return result;
  }

  /**
   * No-op: `basePool` already intersected with the online set, so there is
   * nothing left to filter. Declared explicitly so the port contract is
   * satisfied visibly rather than by omission.
   */
  filterAvailable(
    _scope: AssignmentScope,
    candidateIds: string[],
    _requireOnline: boolean,
  ): Promise<string[]> {
    return Promise.resolve(candidateIds);
  }
}
