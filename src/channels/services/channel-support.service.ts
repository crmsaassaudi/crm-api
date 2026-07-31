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
  DEFAULT_CHANNEL_SUPPORT,
} from '../domain/channel';
import { UpdateChannelSupportDto } from '../dto/channel.dto';
import { escapeRegex } from '../../utils/escape-regex';

/**
 * (direct ∪ group members) \ excluded — the one definition of "who is in the
 * pool", shared by the read path (buildPools) and the write-time validation so
 * the two can never disagree about whether a pool is empty.
 *
 * Exclusions are subtracted last on purpose: an admin who both selects a group
 * and excludes one of its members means the exclusion, and an id that appears
 * in `userIds` and `excludedUserIds` at once is a contradiction that must
 * resolve the safe way (denied).
 */
function unionMinusExclusions(
  support: Pick<ChannelSupport, 'userIds' | 'groupIds' | 'excludedUserIds'>,
  membersByGroup: Map<string, string[]>,
): string[] {
  const direct = (support.userIds ?? []).map(String);
  const fromGroups = (support.groupIds ?? [])
    .map(String)
    .flatMap((gid) => membersByGroup.get(gid) ?? []);
  const excluded = new Set((support.excludedUserIds ?? []).map(String));
  return [...new Set([...direct, ...fromGroups])].filter(
    (id) => !excluded.has(id),
  );
}

/**
 * Error code returned when an agent outside a restricted channel's support pool
 * is targeted by an assignment. Clients key retry/UX off this, not the message.
 */
export const AGENT_NOT_IN_CHANNEL_POOL = 'OMNI_AGENT_NOT_IN_CHANNEL_POOL';

/** Same, for a group that does not serve the channel. */
export const GROUP_NOT_IN_CHANNEL_POOL = 'OMNI_GROUP_NOT_IN_CHANNEL_POOL';

/**
 * Returned when a save would leave a restricted channel with zero eligible
 * agents. Recoverable by resending with `allowEmptyPool: true`.
 */
export const CHANNEL_SUPPORT_EMPTY_POOL = 'CHANNEL_SUPPORT_EMPTY_POOL';

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
  /** Ids subtracted from the union — kept for explainability in the admin UI. */
  excludedUserIds: string[];
  /** 'inherit' unless the channel explicitly overrides the tenant default (M18). */
  visibility: ChannelVisibility;
}

/** A user as the admin pool UI needs to render them. */
export interface PoolMemberRef {
  id: string;
  name: string;
  email: string | null;
  /** Soft-deleted, or no longer a member of the tenant. */
  deleted: boolean;
}

/** A support group as the admin pool UI needs to render it. */
export interface PoolGroupRef {
  id: string;
  name: string;
  /** Members this group actually contributes (0 when inactive). */
  memberCount: number;
  isActive: boolean;
  /** Referenced id no longer resolves to a group in this tenant. */
  missing: boolean;
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
      excludedUserIds: dto.excludedUserIds ?? current.excludedUserIds ?? [],
      mode: dto.mode ?? current.mode,
    };
    const currentVisibility: ChannelVisibility =
      channel.visibility ?? 'inherit';
    const nextVisibility: ChannelVisibility =
      dto.visibility ?? currentVisibility;

    // Dedupe before validating so a repeated id is not reported twice.
    next.userIds = [...new Set(next.userIds.map(String))];
    next.groupIds = [...new Set(next.groupIds.map(String))];
    next.excludedUserIds = [...new Set(next.excludedUserIds.map(String))];

    await this.assertUsersInTenant(tenantId, [
      ...next.userIds,
      ...next.excludedUserIds,
    ]);
    await this.assertGroupsInTenant(tenantId, next.groupIds);

    // An empty restricted pool is a valid state — it takes a channel out of
    // service — but never an accidental one. Resolved with the same code path
    // routing uses, so what is validated here is exactly what will be enforced.
    if (next.mode === 'restricted' && !dto.allowEmptyPool) {
      const resolved = await this.resolveAgentIdsFor(tenantId, next);
      if (resolved.length === 0) {
        throw new UnprocessableEntityException({
          code: CHANNEL_SUPPORT_EMPTY_POOL,
          message:
            'This channel is restricted but no agent resolves into its support ' +
            'pool, so nobody would be able to serve or read it. Add an agent or ' +
            'a group, switch the channel to open, or resend with allowEmptyPool.',
        });
      }
    }

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
    if (opts.userId) {
      pull['support.userIds'] = new Types.ObjectId(opts.userId);
      // Also drop the exclusion entry: leaving it behind would silently deny a
      // future user who is assigned the same id (recycled ObjectIds do not
      // happen, but a restored user does) and clutters the admin UI with a
      // tombstone it cannot render a name for.
      pull['support.excludedUserIds'] = new Types.ObjectId(opts.userId);
    }
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
   * Cursor-light, server-ranked assignment picker. It avoids sending the full
   * tenant directory to every agent workspace and intersects results with the
   * same resolved support pool used by assignment enforcement.
   */
  async searchAssignmentCandidates(
    tenantId: string,
    channelId: string,
    options: {
      type: 'agent' | 'group';
      search?: string;
      limit?: number;
    },
  ): Promise<Array<{ id: string; displayName: string }>> {
    const pool = await this.resolvePool(tenantId, channelId);
    const limit = Math.min(50, Math.max(1, options.limit ?? 25));
    const queryText = String(options.search ?? '').trim();
    const search = queryText
      ? { $regex: escapeRegex(queryText), $options: 'i' }
      : undefined;

    if (options.type === 'group') {
      const filter: Record<string, unknown> = {
        tenantId: toObjectId(tenantId),
        isActive: { $ne: false },
      };
      if (pool?.mode === 'restricted') {
        filter._id = {
          $in: pool.groupIds
            .filter((id) => Types.ObjectId.isValid(id))
            .map((id) => new Types.ObjectId(id)),
        };
      }
      if (search) filter.name = search;
      const groups = await this.groupModel
        .find(filter, { name: 1 })
        .sort({ name: 1, _id: 1 })
        .limit(limit)
        .lean()
        .exec();
      return groups.map((group: any) => ({
        id: String(group._id),
        displayName: String(group.name),
      }));
    }

    const filter: Record<string, unknown> = {
      'tenants.tenantId': toObjectId(tenantId),
      deletedAt: { $exists: false },
      isActive: { $ne: false },
    };
    if (pool?.agentIds) {
      filter._id = {
        $in: pool.agentIds
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id)),
      };
    }
    if (search) {
      filter.$or = [
        { firstName: search },
        { lastName: search },
        { email: search },
      ];
    }
    const users = await this.userModel
      .find(filter, { firstName: 1, lastName: 1, email: 1 })
      .sort({ firstName: 1, lastName: 1, _id: 1 })
      .limit(limit)
      .lean()
      .exec();
    return users.map((user: any) => ({
      id: String(user._id),
      displayName:
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        user.email ||
        String(user._id),
    }));
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

  /**
   * The pool of a channel, resolved and annotated with display names.
   *
   * Exists because the admin UI cannot answer "who is actually in this pool?"
   * from the raw id lists: the ids come from a paginated user list, so a
   * selected agent who is not on the current page would render as nothing, and
   * group membership is not client-side knowledge at all. The UI shows chips
   * and an effective-agent count from this, which is the same computation
   * routing performs.
   */
  async describePool(
    tenantId: string,
    channelId: string,
  ): Promise<{
    channelId: string;
    mode: ChannelSupportMode;
    visibility: ChannelVisibility;
    users: PoolMemberRef[];
    groups: PoolGroupRef[];
    excludedUsers: PoolMemberRef[];
    /** Everyone the pool resolves to; null when the channel is unrestricted. */
    effectiveAgents: PoolMemberRef[] | null;
  }> {
    const channel = await this.channelRepository.findById(tenantId, channelId);
    if (!channel) throw new NotFoundException('Channel not found');

    const support = channel.support ?? { ...DEFAULT_CHANNEL_SUPPORT };
    const membersByGroup = await this.loadGroupMembers(
      tenantId,
      (support.groupIds ?? []).map(String),
    );
    const effectiveIds = unionMinusExclusions(support, membersByGroup);

    // One user read for every id the response mentions, rather than three.
    const userIds = [
      ...new Set([
        ...(support.userIds ?? []).map(String),
        ...(support.excludedUserIds ?? []).map(String),
        ...effectiveIds,
      ]),
    ];
    const namesById = await this.loadUserRefs(tenantId, userIds);
    const groups = await this.loadGroupRefs(
      tenantId,
      (support.groupIds ?? []).map(String),
      membersByGroup,
    );
    const ref = (id: string): PoolMemberRef =>
      namesById.get(id) ?? { id, name: id, email: null, deleted: true };

    return {
      channelId: String(channel.id),
      mode: support.mode === 'restricted' ? 'restricted' : 'open',
      visibility: channel.visibility ?? 'inherit',
      users: (support.userIds ?? []).map(String).map(ref),
      groups,
      excludedUsers: (support.excludedUserIds ?? []).map(String).map(ref),
      effectiveAgents:
        support.mode === 'restricted' ? effectiveIds.map(ref) : null,
    };
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
      const support = channel.support ?? { ...DEFAULT_CHANNEL_SUPPORT };
      const groupIds = (support.groupIds ?? []).map(String);
      const excludedUserIds = (support.excludedUserIds ?? []).map(String);
      const union = unionMinusExclusions(support, membersByGroup);

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
        excludedUserIds,
        visibility: channel.visibility ?? 'inherit',
      });
    }

    return result;
  }

  /**
   * Resolve one not-yet-persisted support shape into agent ids. Used by the
   * write path so the empty-pool check sees exactly what buildPools would
   * produce, without waiting for the cache to be rebuilt.
   */
  private async resolveAgentIdsFor(
    tenantId: string,
    support: ChannelSupport,
  ): Promise<string[]> {
    const membersByGroup = await this.loadGroupMembers(
      tenantId,
      (support.groupIds ?? []).map(String),
    );
    return unionMinusExclusions(support, membersByGroup);
  }

  /** Display refs for a set of user ids, keyed by id. Missing ids are absent. */
  private async loadUserRefs(
    tenantId: string,
    userIds: string[],
  ): Promise<Map<string, PoolMemberRef>> {
    const map = new Map<string, PoolMemberRef>();
    if (userIds.length === 0) return map;

    const objectIds = userIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const users = await this.userModel
      .find({
        _id: { $in: objectIds },
        'tenants.tenantId': new Types.ObjectId(tenantId),
      })
      .select('_id firstName lastName email deletedAt')
      .lean()
      .exec();

    for (const u of users as any[]) {
      const name =
        [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '—';
      map.set(String(u._id), {
        id: String(u._id),
        name,
        email: u.email ?? null,
        deleted: !!u.deletedAt,
      });
    }
    return map;
  }

  private async loadGroupRefs(
    tenantId: string,
    groupIds: string[],
    membersByGroup: Map<string, string[]>,
  ): Promise<PoolGroupRef[]> {
    if (groupIds.length === 0) return [];

    const objectIds = groupIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const groups = await this.groupModel
      .find({ _id: { $in: objectIds }, tenantId: new Types.ObjectId(tenantId) })
      .select('_id name isActive')
      .lean()
      .exec();

    const byId = new Map(groups.map((g: any) => [String(g._id), g]));
    return groupIds.map((id) => {
      const g: any = byId.get(id);
      return {
        id,
        name: g?.name ?? id,
        // membersByGroup only contains ACTIVE groups (loadGroupMembers filters
        // on isActive), so an inactive group correctly reports 0 contributed
        // members rather than its roster — which is what routing sees.
        memberCount: (membersByGroup.get(id) ?? []).length,
        isActive: g ? g.isActive !== false : false,
        missing: !g,
      };
    });
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

const toObjectId = (value: string): string | Types.ObjectId =>
  Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : value;
