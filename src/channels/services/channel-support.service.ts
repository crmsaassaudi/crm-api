import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { ChannelRepository } from '../infrastructure/persistence/document/repositories/channel.repository';
import {
  ChannelSupport,
  ChannelSupportMode,
  ChannelVisibility,
} from '../domain/channel';
import { UpdateChannelSupportDto } from '../dto/channel.dto';

/**
 * Error code returned when an agent outside a restricted channel's support pool
 * is targeted by an assignment. Clients key retry/UX off this, not the message.
 */
export const AGENT_NOT_IN_CHANNEL_POOL = 'OMNI_AGENT_NOT_IN_CHANNEL_POOL';

/** Same, for a group that does not serve the channel. */
export const GROUP_NOT_IN_CHANNEL_POOL = 'OMNI_GROUP_NOT_IN_CHANNEL_POOL';

/**
 * The resolved serving pool of one channel.
 *
 * `agentIds === null` means "no restriction" — either the channel is in `open`
 * mode or it has no pool configured. Callers must treat null and `[]` as
 * opposites: null admits everyone, `[]` admits nobody.
 */
export interface ResolvedChannelPool {
  channelId: string;
  mode: ChannelSupportMode;
  agentIds: string[] | null;
  groupIds: string[];
  /** 'inherit' unless the channel explicitly overrides the tenant default (M18). */
  visibility: ChannelVisibility;
}

/**
 * ChannelSupportService — the single seam through which every "may this agent
 * serve this channel?" question flows.
 *
 * Before this service the support pool lived as untyped keys in `channel.config`
 * and was only ever applied by React when it rendered the agent dropdown, which
 * made it a hint rather than a rule: a direct API call could assign any user in
 * the tenant to any conversation. Every assignment path now calls
 * `assertAgentEligible` / `assertGroupEligible`, and conversation visibility is
 * narrowed by `listServableChannelIds`.
 *
 * Pools are cached in-memory per tenant for a short TTL because they are read
 * on every inbound message and every conversation-list request but written only
 * by an admin. `invalidate()` drops the cache on write.
 */
@Injectable()
export class ChannelSupportService {
  private readonly logger = new Logger(ChannelSupportService.name);

  /** tenantId → { pools by channelId, expiresAt } */
  private readonly poolCache = new Map<
    string,
    { pools: Map<string, ResolvedChannelPool>; expiresAt: number }
  >();

  private readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly channelRepository: ChannelRepository,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    @InjectModel('GroupSchemaClass')
    private readonly groupModel: Model<any>,
    @InjectModel('UserSchemaClass')
    private readonly userModel: Model<any>,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  // Write path
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Replace the support pool of a channel. Omitted DTO fields keep their
   * current value, so a caller can flip `mode` without resending the lists.
   *
   * Both lists are checked against the tenant before being stored: a user id
   * from another tenant, or a soft-deleted user, is rejected outright rather
   * than being written and silently failing to match at routing time.
   */
  async updateSupport(
    channelId: string,
    dto: UpdateChannelSupportDto,
  ): Promise<ChannelSupport> {
    const tenantId = this.cls.get('tenantId');
    const channel = await this.channelRepository.findById(tenantId, channelId);
    if (!channel) throw new NotFoundException('Channel not found');

    const current = channel.support;
    const next: ChannelSupport = {
      userIds: dto.userIds ?? current.userIds,
      groupIds: dto.groupIds ?? current.groupIds,
      mode: dto.mode ?? current.mode,
    };
    const currentVisibility: ChannelVisibility =
      channel.visibility ?? 'inherit';
    const nextVisibility: ChannelVisibility =
      dto.visibility ?? currentVisibility;

    // Dedupe before validating so a repeated id is not reported twice.
    next.userIds = [...new Set(next.userIds.map(String))];
    next.groupIds = [...new Set(next.groupIds.map(String))];

    await this.assertUsersInTenant(tenantId, next.userIds);
    await this.assertGroupsInTenant(tenantId, next.groupIds);

    const updated = await this.channelRepository.update(tenantId, channelId, {
      support: next,
      visibility: nextVisibility,
    } as any);
    if (!updated) throw new NotFoundException('Channel not found');

    this.invalidate(tenantId);

    // Reuse the channel-config audit trail: same tenant, same retention, and
    // `configId` is already an opaque id. Handled by ChannelConfigAuditService,
    // which swallows its own failures — an audit write must never fail the save.
    this.eventEmitter.emit('channel-config.audit.updated', {
      configId: channelId,
      configName: channel.name,
      providerType: channel.type,
      tenantId,
      userId: this.cls.get('userId') ?? 'system',
      changes: {
        support: { before: current, after: next },
        visibility: { before: currentVisibility, after: nextVisibility },
      },
    });

    this.logger.log(
      `Channel ${channelId} support updated: mode=${next.mode}, ` +
        `users=${next.userIds.length}, groups=${next.groupIds.length}, ` +
        `visibility=${nextVisibility}`,
    );
    return updated.support;
  }

  /**
   * Drop references to a user or group that no longer exists. Called from the
   * user/group deletion listeners so a deleted member cannot linger in a pool
   * and shrink it invisibly.
   */
  async removeMemberReferences(
    tenantId: string,
    opts: { userId?: string; groupId?: string },
  ): Promise<void> {
    const pull: Record<string, unknown> = {};
    if (opts.userId) pull['support.userIds'] = new Types.ObjectId(opts.userId);
    if (opts.groupId)
      pull['support.groupIds'] = new Types.ObjectId(opts.groupId);
    if (Object.keys(pull).length === 0) return;

    await this.channelRepository.pullSupportMembers(tenantId, pull);
    this.invalidate(tenantId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Read path
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Resolve one channel's pool into concrete agent ids (direct members ∪ group
   * members). Returns `agentIds: null` when the channel does not restrict.
   */
  async resolvePool(
    tenantId: string,
    channelId: string,
  ): Promise<ResolvedChannelPool | null> {
    const pools = await this.getPoolsCached(tenantId);
    return pools.get(String(channelId)) ?? null;
  }

  /** Same as resolvePool but keyed by the provider account (inbound path). */
  async resolvePoolByAccount(
    tenantId: string,
    type: string,
    account: string,
  ): Promise<ResolvedChannelPool | null> {
    const channel = await this.channelRepository.findAnyByAccount(
      type,
      account,
    );
    if (!channel || String(channel.tenantId) !== String(tenantId)) return null;
    return this.resolvePool(tenantId, channel.id);
  }

  /**
   * The agent ids eligible to serve a channel, or null when unrestricted.
   * This is what the UI's agent picker and the routing pool are both built on,
   * so the two can never disagree.
   */
  async resolveEligibleAgents(
    tenantId: string,
    channelId: string,
  ): Promise<string[] | null> {
    const pool = await this.resolvePool(tenantId, channelId);
    return pool?.agentIds ?? null;
  }

  /**
   * Throw unless `agentId` may serve `channelId`.
   *
   * A channel that cannot be resolved (deleted, or a conversation from before
   * the channel existed) is treated as unrestricted: failing closed here would
   * make historical conversations permanently unassignable, which is a worse
   * outcome than the pool not applying to them.
   */
  async assertAgentEligible(
    tenantId: string,
    channelId: string | null | undefined,
    agentId: string | null | undefined,
  ): Promise<void> {
    if (!agentId || !channelId) return;

    const pool = await this.resolvePool(tenantId, channelId);
    if (!pool || pool.mode !== 'restricted' || pool.agentIds === null) return;

    if (!pool.agentIds.includes(String(agentId))) {
      throw new ForbiddenException({
        code: AGENT_NOT_IN_CHANNEL_POOL,
        message: `Agent ${agentId} is not in the support pool of channel ${channelId}`,
      });
    }
  }

  /** Throw unless `groupId` is one of the channel's support groups. */
  async assertGroupEligible(
    tenantId: string,
    channelId: string | null | undefined,
    groupId: string | null | undefined,
  ): Promise<void> {
    if (!groupId || !channelId) return;

    const pool = await this.resolvePool(tenantId, channelId);
    if (!pool || pool.mode !== 'restricted') return;
    if (pool.groupIds.length === 0) return;

    if (!pool.groupIds.includes(String(groupId))) {
      throw new ForbiddenException({
        code: GROUP_NOT_IN_CHANNEL_POOL,
        message: `Group ${groupId} does not serve channel ${channelId}`,
      });
    }
  }

  /**
   * Channel ids this principal may serve — the basis of conversation
   * visibility. Returns null when the principal is unrestricted, meaning every
   * channel is either `open` or lists them.
   *
   * A channel in `open` mode is servable by everyone, so it never narrows the
   * scope; only `restricted` channels the principal is absent from do.
   */
  async listServableChannelIds(
    tenantId: string,
    userId: string,
  ): Promise<string[] | null> {
    const pools = await this.getPoolsCached(tenantId);
    if (pools.size === 0) return null;

    const servable: string[] = [];
    let restrictedExists = false;

    for (const pool of pools.values()) {
      if (pool.mode !== 'restricted' || pool.agentIds === null) {
        servable.push(pool.channelId);
        continue;
      }
      restrictedExists = true;
      // L19: `agentIds` is already the union of direct userIds and active
      // group members (buildPools). Checking `pool.groupIds` again here used
      // to let a channel stay "visible" through a group that had gone
      // inactive — a group buildPools had already dropped from the pool a
      // user could actually be assigned in. One source of truth: membership
      // in the resolved pool, same as assertAgentEligible / routing use.
      if (pool.agentIds.includes(String(userId))) servable.push(pool.channelId);
    }

    // Nothing restricts this tenant — skip the extra filter clause entirely.
    return restrictedExists ? servable : null;
  }

  /**
   * Channels that explicitly override the tenant's data_visibility default
   * (M18), keyed by channel id. Channels left at 'inherit' are omitted so
   * callers can cheaply check "does anything override here at all" via
   * `.size === 0` before doing any extra scope work.
   */
  async listVisibilityOverrides(
    tenantId: string,
  ): Promise<Map<string, 'private' | 'public_read'>> {
    const pools = await this.getPoolsCached(tenantId);
    const overrides = new Map<string, 'private' | 'public_read'>();
    for (const pool of pools.values()) {
      if (pool.visibility === 'private' || pool.visibility === 'public_read') {
        overrides.set(pool.channelId, pool.visibility);
      }
    }
    return overrides;
  }

  invalidate(tenantId: string): void {
    this.poolCache.delete(tenantId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  private async getPoolsCached(
    tenantId: string,
  ): Promise<Map<string, ResolvedChannelPool>> {
    const now = Date.now();
    const cached = this.poolCache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.pools;

    const pools = await this.buildPools(tenantId);
    this.poolCache.set(tenantId, {
      pools,
      expiresAt: now + this.CACHE_TTL_MS,
    });
    return pools;
  }

  /**
   * Build every channel's pool for a tenant in one pass: one channel query plus
   * one group query, rather than a group lookup per channel.
   */
  private async buildPools(
    tenantId: string,
  ): Promise<Map<string, ResolvedChannelPool>> {
    const channels = await this.channelRepository.findAll(tenantId);
    const result = new Map<string, ResolvedChannelPool>();
    if (channels.length === 0) return result;

    const allGroupIds = [
      ...new Set(
        channels.flatMap((c) => c.support?.groupIds ?? []).map(String),
      ),
    ];
    const membersByGroup = await this.loadGroupMembers(tenantId, allGroupIds);

    for (const channel of channels) {
      const support = channel.support ?? {
        userIds: [],
        groupIds: [],
        mode: 'open' as const,
      };
      const groupIds = (support.groupIds ?? []).map(String);
      const direct = (support.userIds ?? []).map(String);
      const fromGroups = groupIds.flatMap(
        (gid) => membersByGroup.get(gid) ?? [],
      );
      const union = [...new Set([...direct, ...fromGroups])];

      result.set(String(channel.id), {
        channelId: String(channel.id),
        mode: support.mode === 'restricted' ? 'restricted' : 'open',
        // 'open' always means unrestricted, even if userIds/groupIds still
        // hold a stale list (e.g. left over from a prior 'restricted' period).
        // Only 'restricted' pools are ever bounded — an empty one then means
        // nobody ([], not null), so `assertAgentEligible` rejects rather than
        // admits.
        agentIds: support.mode === 'restricted' ? union : null,
        groupIds,
        visibility: channel.visibility ?? 'inherit',
      });
    }

    return result;
  }

  private async loadGroupMembers(
    tenantId: string,
    groupIds: string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (groupIds.length === 0) return map;

    const objectIds = groupIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const groups = await this.groupModel
      .find({
        _id: { $in: objectIds },
        tenantId: new Types.ObjectId(tenantId),
        isActive: true,
      })
      .select('_id memberIds')
      .lean()
      .exec();

    for (const g of groups) {
      map.set(String(g._id), (g.memberIds ?? []).map(String));
    }
    return map;
  }

  private async assertUsersInTenant(
    tenantId: string,
    userIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) return;

    const objectIds = userIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const found = await this.userModel
      .find({
        _id: { $in: objectIds },
        'tenants.tenantId': new Types.ObjectId(tenantId),
        deletedAt: null,
      })
      .select('_id')
      .lean()
      .exec();

    const foundSet = new Set(found.map((u: any) => String(u._id)));
    const missing = userIds.filter((id) => !foundSet.has(String(id)));
    if (missing.length > 0) {
      throw new UnprocessableEntityException({
        code: 'CHANNEL_SUPPORT_UNKNOWN_USERS',
        message: `Not members of this tenant: ${missing.join(', ')}`,
      });
    }
  }

  private async assertGroupsInTenant(
    tenantId: string,
    groupIds: string[],
  ): Promise<void> {
    if (groupIds.length === 0) return;

    const objectIds = groupIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const found = await this.groupModel
      .find({
        _id: { $in: objectIds },
        tenantId: new Types.ObjectId(tenantId),
      })
      .select('_id')
      .lean()
      .exec();

    const foundSet = new Set(found.map((g: any) => String(g._id)));
    const missing = groupIds.filter((id) => !foundSet.has(String(id)));
    if (missing.length > 0) {
      throw new UnprocessableEntityException({
        code: 'CHANNEL_SUPPORT_UNKNOWN_GROUPS',
        message: `Groups not found in this tenant: ${missing.join(', ')}`,
      });
    }
  }
}
