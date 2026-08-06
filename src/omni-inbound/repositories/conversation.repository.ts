import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, SortOrder, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../infrastructure/persistence/document/entities/omni-conversation.schema';
import { OmniConversation } from '../domain/omni-conversation';
import { OmniConversationMapper } from '../infrastructure/persistence/document/mappers/omni-conversation.mapper';
import { PaginationResponseDto } from '../../utils/dto/pagination-response.dto';
import { pagination } from '../../utils/pagination';
import { cappedCount } from '../../utils/capped-count';

export interface ConversationDateRange {
  field: 'createdAt' | 'updatedAt';
  from?: Date;
  to?: Date;
}

export type UnansweredMode = 'recent' | 'longestWaiting' | 'readNotReplied';

export interface ConversationQuery {
  tenantId: string;
  status?: string | string[];
  channels?: string[];
  assignedAgent?: string | string[] | null;
  assignedGroup?: string | string[] | null;
  unassigned?: boolean;
  /** Narrow to rows the group owns but no agent has picked up yet. */
  groupQueueOnly?: boolean;
  sla?: string[];
  tags?: string[];
  tagsMatchMode?: 'any' | 'all';
  isVip?: boolean;
  hasUnread?: boolean;
  search?: string;
  cursor?: string;
  dateRange?: ConversationDateRange;
  unansweredMode?: UnansweredMode;
}

export interface ConversationTimelineCursor {
  createdAt: Date;
  id: string;
}

export interface ThreadSessionSlice {
  sessions: OmniConversation[];
  hasMore: boolean;
  cursor: ConversationTimelineCursor | null;
}

export interface ThreadIdentity {
  tenantId: string;
  channelType: string;
  channelAccount: string;
  externalId: string;
}

@Injectable()
export class ConversationRepository {
  private readonly logger = new Logger(ConversationRepository.name);

  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly model: Model<OmniConversationDocument>,
    private readonly cls: ClsService,
  ) {}

  async findById(id: string): Promise<OmniConversation | null> {
    const doc = await this.model
      .findById(id)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .lean()
      .exec();
    if (!doc) return null;
    // Record-level scope: a scoped user must not read a conversation outside
    // their visibility just by knowing its id — tenant isolation alone is not
    // enough. Fail-closed to null, which the caller reports as "not found".
    if (!this.isConversationInScope(doc)) return null;
    return OmniConversationMapper.toDomain(doc as any);
  }

  /**
   * Whether the current CLS principal may see this conversation, mirroring
   * applyVisibilityScope() for a single already-fetched document.
   */
  private isConversationInScope(doc: any): boolean {
    // Channel axis first: it holds regardless of the owner axis, so a principal
    // outside a restricted channel's pool cannot read its conversations even
    // with an unrestricted owner scope.
    const servable = this.cls.get('servableChannelIds');
    if (Array.isArray(servable)) {
      const channel = doc.channelId ? String(doc.channelId) : null;
      if (!channel || !servable.map(String).includes(channel)) return false;
    }

    // A channel can force 'private' or 'public_read' regardless of the
    // tenant-wide default the rest of this method would otherwise apply.
    const channelId = doc.channelId ? String(doc.channelId) : null;
    const overrides =
      (this.cls.get('channelVisibilityOverrides') as Record<
        string,
        'private' | 'public_read'
      >) ?? {};
    const override = channelId ? overrides[channelId] : undefined;

    const visibleOwnerIds = this.moduleOwnerIds();

    if (!Array.isArray(visibleOwnerIds)) {
      // bypass (admin / public_read / TENANT scope)
      if (override !== 'private') return true;
      const strictOwnerIds = this.cls.get('strictOwnerIds');
      if (!Array.isArray(strictOwnerIds)) return true; // the strict scope itself is unrestricted
      return this.isWithinOwnerScope(
        doc,
        strictOwnerIds,
        this.cls.get('strictOrgUnitIds'),
      );
    }

    if (override === 'public_read') return true;
    return this.isWithinOwnerScope(
      doc,
      visibleOwnerIds,
      this.moduleOrgUnitIds(),
    );
  }

  /**
   * The owner axis for conversations, honouring a per-module override.
   *
   * A tenant can scope Conversation differently from Contact/Deal — "agents see
   * only their own inbox even though the department shares its pipeline" is a
   * common ask. With no override configured this returns the request-wide value,
   * so behaviour is unchanged.
   */
  private moduleOwnerIds(): unknown {
    return this.moduleScope()?.ownerIds ?? this.cls.get('visibleOwnerIds');
  }

  private moduleOrgUnitIds(): unknown {
    return this.moduleScope()?.orgUnitIds ?? this.cls.get('visibleOrgUnitIds');
  }

  private moduleScope():
    | { ownerIds: string[] | null; orgUnitIds: string[] | null }
    | undefined {
    const byModule = this.cls.get('dataVisibilityByModule') as
      | Record<
          string,
          { ownerIds: string[] | null; orgUnitIds: string[] | null }
        >
      | undefined;
    return byModule?.Conversation;
  }

  /** Owner/org-unit/group scope check shared by the normal and strict paths. */
  private isWithinOwnerScope(
    doc: any,
    ownerIds: string[],
    orgUnitIds: unknown,
  ): boolean {
    const owners = new Set(ownerIds.map(String));
    const groups = new Set(
      ((this.cls.get('visibleGroupIds') as string[]) ?? []).map(String),
    );
    const agent = doc.assignedAgentId ? String(doc.assignedAgentId) : null;
    const claimer = doc.claimedById ? String(doc.claimedById) : null;
    const group = doc.assignedGroupId ? String(doc.assignedGroupId) : null;

    if (agent && owners.has(agent)) return true;
    if (claimer && owners.has(claimer)) return true;
    if (group && groups.has(group)) return true;
    if (!agent && !group && this.cls.get('includeUnownedInScope') === true) {
      return true;
    }

    if (Array.isArray(orgUnitIds) && orgUnitIds.length > 0) {
      const orgUnit = doc.orgUnitId ? String(doc.orgUnitId) : null;
      if (orgUnit && orgUnitIds.map(String).includes(orgUnit)) return true;
    }
    return false;
  }

  async findByIds(
    tenantId: string,
    ids: string[],
  ): Promise<OmniConversation[]> {
    const safeIds = Array.from(new Set(ids)).filter((id) =>
      Types.ObjectId.isValid(id),
    );
    if (safeIds.length === 0) return [];

    const docs = await this.model
      .find({ _id: { $in: safeIds }, tenantId })
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .lean()
      .exec();

    return docs.map((doc) => OmniConversationMapper.toDomain(doc as any));
  }

  /**
   * The ACTIVE (open or pending) conversation for a given external thread id.
   *
   * The key query for session management: no active session means the caller
   * should create a new one rather than reopen a resolved thread.
   */
  async findActiveByExternalId(
    tenantId: string,
    channelType: string,
    channelAccount: string,
    externalId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOne({
        tenantId,
        channelType,
        channelAccount,
        externalId,
        status: { $in: ['open', 'pending'] },
      })
      .sort({ createdAt: -1 }) // latest active session
      .lean()
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc as any) : null;
  }

  async create(
    data: Partial<OmniConversationSchemaClass>,
  ): Promise<OmniConversation> {
    const doc = await this.model.create(data);
    return OmniConversationMapper.toDomain(doc);
  }

  /**
   * Paginated list of conversations for a tenant, sorted by last activity.
   */
  async findPaginated(
    query: ConversationQuery,
    page: number,
    limit: number,
  ): Promise<PaginationResponseDto<OmniConversation>> {
    const filter = this.buildFilter(query);
    const sort: Record<string, SortOrder> = { lastMessageAt: -1 };

    // Convert 1-indexed to 0-indexed for Mongoose skip
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * limit;

    const [items, { totalItems: total }] = await Promise.all([
      this.model
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('assignedAgent')
        .populate('resolvedByAgent')
        .lean()
        .exec(),
      cappedCount(this.model as Model<any>, filter),
    ]);

    const mappedItems = items.map((doc) =>
      OmniConversationMapper.toDomain(doc as any),
    );

    return pagination(mappedItems, total, { page: safePage, limit });
  }

  async findCursorPaginated(query: ConversationQuery, limit: number) {
    const filter = this.buildFilter(query);

    // "Longest waiting" flips the sort to oldest-first so the most
    // overdue unanswered conversations surface at the top of the list.
    const sortDir: 1 | -1 = query.unansweredMode === 'longestWaiting' ? 1 : -1;

    // The cursor carries `_id` alongside the timestamp because the sort does.
    //
    // Filtering on `lastMessageAt` alone while sorting by `(lastMessageAt, _id)`
    // is only safe when timestamps are unique, and here they are routinely not:
    // providers report whole seconds, and a burst of inbound messages stamps
    // several conversations identically. Every row sharing the boundary
    // timestamp was then either skipped or repeated across the page break — a
    // customer conversation silently missing from the agent's queue.
    const cursor = this.decodeConversationCursor(query.cursor);
    if (cursor) {
      const comparison = sortDir === -1 ? '$lt' : '$gt';
      (filter.$and ??= []).push(
        cursor.id
          ? {
              $or: [
                { lastMessageAt: { [comparison]: cursor.lastMessageAt } },
                {
                  lastMessageAt: cursor.lastMessageAt,
                  _id: { [comparison]: new Types.ObjectId(cursor.id) },
                },
              ],
            }
          : // Legacy timestamp-only cursor: keep the exact behaviour it had.
            { lastMessageAt: { [comparison]: cursor.lastMessageAt } },
      );
    }

    const safeLimit = Math.max(1, Math.min(limit, 50));

    // Fetch limit + 1 to check if there are more items
    const items = await this.model
      .find(filter)
      .sort({ lastMessageAt: sortDir, _id: sortDir })
      .limit(safeLimit + 1)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .lean()
      .exec();

    const hasNextPage = items.length > safeLimit;
    const pageItems = hasNextPage ? items.slice(0, safeLimit) : items;

    const mappedItems = pageItems.map((doc) =>
      OmniConversationMapper.toDomain(doc as any),
    );

    const lastItem = pageItems[pageItems.length - 1];
    const nextCursor =
      hasNextPage && lastItem?.lastMessageAt
        ? this.encodeConversationCursor(
            lastItem.lastMessageAt,
            String(lastItem._id),
          )
        : null;

    return {
      data: mappedItems,
      nextCursor,
      hasNextPage,
      totalItems: undefined,
    };
  }

  /**
   * Encode the page boundary as `<iso>|<id>`.
   *
   * Plain text rather than base64 so an operator reading a log or a support
   * ticket can see which conversation a client is stuck on.
   */
  private encodeConversationCursor(lastMessageAt: Date, id: string): string {
    return `${lastMessageAt.toISOString()}|${id}`;
  }

  /**
   * Decode a cursor, accepting the older timestamp-only form.
   *
   * Compatibility is not optional here: the previous cursor was a bare ISO
   * string, and every inbox open in a browser at deploy time holds one. Rejecting
   * it would turn a fix for a rare missing row into an immediate error for every
   * agent mid-scroll. A legacy cursor keeps its old semantics — it can still
   * skip a row on a timestamp tie — which is strictly what the caller already
   * had, and it disappears as soon as the client pages again.
   */
  private decodeConversationCursor(
    raw: string | undefined,
  ): { lastMessageAt: Date; id: string | null } | null {
    if (!raw) return null;
    const [timestamp, id] = raw.split('|');
    const lastMessageAt = new Date(timestamp);
    if (Number.isNaN(lastMessageAt.getTime())) return null;
    return {
      lastMessageAt,
      id: id && Types.ObjectId.isValid(id) ? id : null,
    };
  }

  private buildFilter(
    query: ConversationQuery,
  ): FilterQuery<OmniConversationDocument> {
    const filter: FilterQuery<OmniConversationDocument> = {
      tenantId: query.tenantId,
    };

    this.applyStatusFilter(filter, query.status);
    this.applyChannelFilter(filter, query.channels);
    this.buildAssignmentFilter(query, filter);
    this.applySlaFilter(filter, query.sla);
    this.applyTagsFilter(filter, query.tags, query.tagsMatchMode);
    this.applyVipFilter(filter, query.isVip);
    this.applyUnreadFilter(filter, query.hasUnread);
    this.applySearchFilter(filter, query.search);
    this.applyDateRangeFilter(filter, query.dateRange);
    this.applyUnansweredFilter(filter, query.unansweredMode);
    this.applyVisibilityScope(filter);

    return filter;
  }

  /**
   * Enforce data-visibility scope on conversations. Conversations have no
   * `ownerId`, so scope maps onto assignment: a scoped (non-admin) user may
   * only see conversations assigned to a visible agent (self + subordinates),
   * assigned to one of their groups, or claimed by a visible agent.
   *
   * Read from CLS (set by DataVisibilityInterceptor):
   *   - visibleOwnerIds: null → admin/owner bypass (no restriction)
   *                      string[] → restrict to these agent IDs
   *   - visibleGroupIds: groups the user belongs to
   *   - includeUnownedInScope: whether unassigned conversations are visible
   *
   * The clause is ANDed on top of any caller-supplied assignment filter, so a
   * scoped user cannot widen their view by passing assignedAgent/assignedGroup.
   */
  private applyVisibilityScope(
    filter: FilterQuery<OmniConversationDocument>,
  ): void {
    this.applyChannelScope(filter);

    const overrides =
      (this.cls.get('channelVisibilityOverrides') as Record<
        string,
        'private' | 'public_read'
      >) ?? {};
    const publicReadChannelIds = this.channelObjectIds(
      overrides,
      'public_read',
    );
    const privateChannelIds = this.channelObjectIds(overrides, 'private');

    const visibleOwnerIds = this.moduleOwnerIds();

    if (!Array.isArray(visibleOwnerIds)) {
      // Bypass (admin/owner, public_read, or TENANT scope) — undefined means
      // "not evaluated" (system path), which never has overrides either.
      if (privateChannelIds.length === 0) return;

      // One or more channels force 'private' regardless of the bypass
      // above. Everything outside those channels stays unrestricted; inside
      // them, the viewer's own scope (computed as `strictOwnerIds` by
      // DataVisibilityInterceptor) applies.
      const strictOwnerIds = this.cls.get('strictOwnerIds');
      if (!Array.isArray(strictOwnerIds)) return; // strict scope itself unrestricted

      const strictClauses = this.buildOwnerScopeClauses(
        strictOwnerIds,
        this.cls.get('strictOrgUnitIds'),
      );
      (filter.$and ??= []).push({
        $or: [
          { channelId: { $nin: privateChannelIds } },
          {
            $and: [
              { channelId: { $in: privateChannelIds } },
              { $or: strictClauses },
            ],
          },
        ],
      });
      return;
    }

    const scopeClauses = this.buildOwnerScopeClauses(
      visibleOwnerIds,
      this.moduleOrgUnitIds(),
    );
    if (publicReadChannelIds.length > 0) {
      // These channels bypass the owner scope regardless of it.
      scopeClauses.push({ channelId: { $in: publicReadChannelIds } });
    }

    (filter.$and ??= []).push({ $or: scopeClauses });
  }

  /**
   * The owner/group/org-unit scope clauses, shared by the normal path and
   * the strict (M18 per-channel 'private' override) path.
   *
   *   - visibleGroupIds: groups the user belongs to
   *   - includeUnownedInScope: whether unassigned conversations are visible
   *
   * The org-unit axis is unioned like document-repository does for CRM
   * records — "my assignments AND my unit's conversations", not an
   * intersection. Without this a manager scoped to ORG_UNIT saw the
   * department's contacts/deals but none of its conversations.
   */
  private buildOwnerScopeClauses(
    ownerIds: string[],
    orgUnitIds: unknown,
  ): FilterQuery<OmniConversationDocument>[] {
    const visibleGroupIds = (this.cls.get('visibleGroupIds') as string[]) ?? [];
    const clauses: FilterQuery<OmniConversationDocument>[] = [
      { assignedAgentId: { $in: ownerIds } },
      { claimedById: { $in: ownerIds } },
    ];
    if (visibleGroupIds.length > 0) {
      clauses.push({ assignedGroupId: { $in: visibleGroupIds } });
    }
    if (this.cls.get('includeUnownedInScope') === true) {
      clauses.push({ assignedAgentId: null, assignedGroupId: null });
    }
    if (Array.isArray(orgUnitIds) && orgUnitIds.length > 0) {
      clauses.push({ orgUnitId: { $in: orgUnitIds } });
    }
    return clauses;
  }

  /** Channel ids with a given visibility override, as valid ObjectIds. */
  private channelObjectIds(
    overrides: Record<string, 'private' | 'public_read'>,
    kind: 'private' | 'public_read',
  ): Types.ObjectId[] {
    return Object.entries(overrides)
      .filter(([, v]) => v === kind)
      .map(([id]) => id)
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
  }

  /**
   * Narrow to the channels the principal may serve.
   *
   * A separate axis from the owner scope on purpose: a restricted channel is an
   * explicit grant made when configuring the channel, so it must hold even for
   * a principal whose owner scope is unrestricted, and even for conversations
   * that are unassigned. Set by DataVisibilityInterceptor.
   *   - undefined → not evaluated (system/worker path)
   *   - null      → nothing restricts this principal
   *   - string[]  → only these channels
   */
  private applyChannelScope(
    filter: FilterQuery<OmniConversationDocument>,
  ): void {
    const servable = this.cls.get('servableChannelIds');
    if (!Array.isArray(servable)) return;

    const ids = servable
      .filter((id: string) => Types.ObjectId.isValid(id))
      .map((id: string) => new Types.ObjectId(id));

    (filter.$and ??= []).push({ channelId: { $in: ids } });
  }

  /** Filter on createdAt/updatedAt within an inclusive [from, to] range. */
  private applyDateRangeFilter(
    filter: any,
    dateRange: ConversationDateRange | undefined,
  ): void {
    if (!dateRange || (!dateRange.from && !dateRange.to)) return;
    const condition: Record<string, Date> = {};
    if (dateRange.from) condition.$gte = dateRange.from;
    if (dateRange.to) condition.$lte = dateRange.to;
    filter[dateRange.field] = condition;
  }

  /**
   * "Unanswered" = the conversation's last message came from the customer,
   * i.e. the agent has not replied since. `readNotReplied` additionally
   * requires unreadCount=0 (agent opened it but never sent a reply).
   */
  private applyUnansweredFilter(
    filter: any,
    mode: UnansweredMode | undefined,
  ): void {
    if (!mode) return;
    filter.lastMessageSenderType = 'customer';
    if (mode === 'readNotReplied') {
      filter.unreadCount = 0;
    }
  }

  private applyStatusFilter(filter: any, status: any): void {
    if (status) {
      filter.status = Array.isArray(status) ? { $in: status } : status;
    }
  }

  private applyChannelFilter(
    filter: any,
    channels: string[] | undefined,
  ): void {
    if (channels && channels.length > 0) {
      filter.channelType = { $in: channels };
    }
  }

  private applySlaFilter(filter: any, sla: string[] | undefined): void {
    const slaConditions = this.buildSlaFilter(sla);
    if (slaConditions.length > 0) {
      // Pushed into `$and` rather than assigned to `filter.$or`. The bare
      // assignment worked only because nothing else in this builder wrote `$or`
      // — the cursor clause now does, and the visibility scope always could.
      // Two writers to one `$or` key means the second silently erases the
      // first, which for a scope clause means widening what a user can see.
      (filter.$and ??= []).push({ $or: slaConditions });
    }
  }

  private applyTagsFilter(
    filter: any,
    tags: string[] | undefined,
    matchMode?: 'any' | 'all',
  ): void {
    if (tags && tags.length > 0) {
      filter.tags = matchMode === 'all' ? { $all: tags } : { $in: tags };
    }
  }

  private applyVipFilter(filter: any, isVip: boolean | undefined): void {
    if (isVip !== undefined) {
      filter.isVip = isVip;
    }
  }

  private applyUnreadFilter(filter: any, hasUnread: boolean | undefined): void {
    if (hasUnread !== undefined) {
      filter.unreadCount = hasUnread ? { $gt: 0 } : 0;
    }
  }

  private applySearchFilter(filter: any, search: string | undefined): void {
    if (search) {
      filter.$text = { $search: search };
    }
  }

  /**
   * Apply assignment-related filters: unassigned takes precedence over
   * specific agent / group filters.
   */
  private buildAssignmentFilter(
    query: ConversationQuery,
    filter: FilterQuery<OmniConversationDocument>,
  ): void {
    if (query.unassigned) {
      filter.assignedAgentId = null;
      filter.assignedGroupId = null;
      return;
    }
    if (query.assignedAgent !== undefined) {
      filter.assignedAgentId = Array.isArray(query.assignedAgent)
        ? { $in: query.assignedAgent }
        : query.assignedAgent;
    }
    if (query.assignedGroup !== undefined) {
      filter.assignedGroupId = Array.isArray(query.assignedGroup)
        ? { $in: query.assignedGroup }
        : query.assignedGroup;
    }
    // "The queue of the group(s) I'm in": owned by the team but not yet picked
    // up by anyone. Combined with assignedGroup rather than replacing it, so
    // `groupQueueOnly` narrows whichever group filter is already in play.
    if (query.groupQueueOnly) {
      filter.assignedAgentId = null;
    }
  }

  /**
   * Build the SLA `$or` condition array from the requested labels. Empty when no
   * SLA filter is requested.
   *
   * Both branches read the projection written by SlaClockService, so the list
   * stays a single-collection query served by the `conversation_sla` index.
   */
  private buildSlaFilter(sla: string[] | undefined): any[] {
    if (!sla || sla.length === 0) return [];

    const conditions: any[] = [];

    if (sla.includes('breached')) {
      conditions.push({ slaBreached: true });
    }

    // Still inside its target but running out of time. `$gt: now` excludes a
    // deadline that has already passed — that conversation belongs to
    // 'breached', and listing it under 'warning' told the agent they still had
    // time when they did not.
    if (sla.includes('warning')) {
      const now = new Date();
      conditions.push({
        slaBreached: false,
        slaDueAt: { $gt: now, $lte: new Date(now.getTime() + 15 * 60_000) },
      });
    }

    return conditions;
  }

  async updateStatus(
    id: string,
    status: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(id, { status }, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Snooze a conversation: sets status to 'pending' and records when it
   * should automatically reopen. The inbound message handler will check
   * snoozeUntil and reopen to 'open' when the customer messages again.
   */
  async snoozeConversation(
    id: string,
    snoozeUntil: Date,
  ): Promise<{ status: string; snoozeUntil: Date } | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, status: { $in: ['open', 'pending'] } },
        { $set: { status: 'pending', snoozeUntil } },
        { new: true },
      )
      .exec();
    if (!doc) return null;
    return { status: doc.status, snoozeUntil };
  }

  async updateBotState(
    id: string,
    fields: Partial<{
      enabled: boolean;
      provider: string;
      flowId: string | null;
      sessionId: string | null;
      status: 'active' | 'handoff' | 'ended';
      lastError: string | null;
      handoffReason: string | null;
      handoffMessage: string | null;
      handoffTarget: 'general' | 'group' | 'agent' | null;
      handoffTargetId: string | null;
      handedOffAt: Date | null;
      handedOffByInboundMessageId: string | null;
    }>,
  ): Promise<OmniConversation | null> {
    const $set: Record<string, any> = {};
    const $unset: Record<string, 1> = {};

    for (const [key, value] of Object.entries(fields)) {
      const path = `bot.${key}`;
      if (value === null) {
        $unset[path] = 1;
      } else if (value !== undefined) {
        $set[path] = value;
      }
    }

    const update: Record<string, any> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;
    if (Object.keys(update).length === 0) return this.findById(id);

    const doc = await this.model
      .findByIdAndUpdate(id, update, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  async markBotHandoff(
    id: string,
    context: {
      reason: string;
      message?: string;
      target: 'general' | 'group' | 'agent';
      targetId?: string;
      inboundMessageId?: string;
    },
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: id,
          'bot.enabled': true,
          'bot.status': 'active',
        },
        {
          $set: {
            'bot.enabled': false,
            'bot.status': 'handoff',
            'bot.handoffReason': context.reason,
            'bot.handoffMessage': context.message ?? null,
            'bot.handoffTarget': context.target,
            'bot.handoffTargetId': context.targetId ?? null,
            'bot.handedOffAt': new Date(),
            'bot.handedOffByInboundMessageId': context.inboundMessageId ?? null,
          },
        },
        { new: true },
      )
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * The queue-timeline half of an ownership change, as an aggregation-pipeline
   * `$set` stage.
   *
   * There are five write paths that change who owns a conversation
   * (`assignAgent`, `assignIfUnassigned`, `reassignIfExpected`,
   * `updateAssignment`, `claimConversation`). Every one of them has to keep the
   * wait clock honest, so the arithmetic lives here once instead of five times.
   *
   * A pipeline update rather than `$set` + a read: `totalQueuedMs` needs the
   * document's own `queuedAt` to compute the elapsed wait, and doing that in the
   * server keeps the whole transition atomic — read-modify-write from the
   * application would lose one of two concurrent assignments' wait time.
   */
  private ownershipTiming(
    agentId: string | null,
    now: Date,
  ): Record<string, unknown> {
    if (!agentId) {
      // Back to the queue: the wait restarts now. `assignedAt` stays as the
      // record of the last time somebody did own it.
      return { assignedAgentId: null, queuedAt: now };
    }

    return {
      assignedAgentId: agentId,
      assignedAt: now,
      queuedAt: null,
      totalQueuedMs: {
        $add: [
          { $ifNull: ['$totalQueuedMs', 0] },
          {
            $cond: [
              { $ne: [{ $ifNull: ['$queuedAt', null] }, null] },
              { $subtract: [now, '$queuedAt'] },
              0,
            ],
          },
        ],
      },
    };
  }

  /**
   * Directly assign a specific agent to the conversation.
   * Used by targeted Handoff blocks (target = "agent").
   */
  async assignAgent(
    id: string,
    agentId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, status: { $in: ['open', 'pending'] } },
        [
          {
            $set: {
              ...this.ownershipTiming(agentId, new Date()),
              status: 'open',
            },
          },
        ],
        { new: true },
      )
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Assign a conversation to a specific group/team.
   * Used by targeted Handoff blocks (target = "group").
   */
  async assignGroup(
    id: string,
    groupId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(
        id,
        {
          $set: {
            assignedGroupId: groupId,
          },
        },
        { new: true },
      )
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Update status with metadata — captures who resolved/closed and when.
   * Also invalidates identity cache by emitting an event.
   */
  async updateStatusWithMetadata(
    id: string,
    status: 'resolved' | 'closed',
    agentId: string | null,
    reason?: string,
    note?: string,
    resolveSource?: string,
  ): Promise<OmniConversation | null> {
    const update: Record<string, any> = { status };

    update.resolvedByAgentId = agentId;
    update.resolvedAt = new Date();
    update.resolveSource = resolveSource ?? 'agent';
    if (note) update.resolveNote = note;
    if (reason) {
      update.resolveReason = reason;
    }

    const doc = await this.model
      .findByIdAndUpdate(id, update, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Find the most recent conversation by external ID, regardless of status.
   * Used when creating a new session to link back to the previous one.
   */
  async findLastByExternalId(
    tenantId: string,
    channelType: string,
    channelAccount: string,
    externalId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOne({
        tenantId,
        channelType,
        channelAccount,
        externalId,
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc as any) : null;
  }

  async updateLastMessage(
    id: string,
    lastMessage: string,
    lastMessageAt: Date,
    senderType?: string,
  ): Promise<void> {
    const update: Record<string, any> = {
      lastMessage,
      lastMessageAt,
      $inc: { messageCount: 1 },
    };

    // Only increment unread count for customer messages — agent/system
    // messages should not trigger the unread badge.
    if (!senderType || senderType === 'customer') {
      update.$inc.unreadCount = 1;
    }

    await this.model.findByIdAndUpdate(id, update).exec();
  }

  /**
   * Update the timestamp of the customer's most recent inbound message.
   * Used to calculate the platform reply window (e.g. 24h for Facebook).
   */
  async updateLastCustomerMessageAt(id: string, date: Date): Promise<void> {
    await this.model
      .findByIdAndUpdate(id, { $set: { lastCustomerMessageAt: date } })
      .exec();
  }

  async addTag(id: string, tag: string): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(id, { $addToSet: { tags: tag } }, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  async removeTag(id: string, tag: string): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(id, { $pull: { tags: tag } }, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Bulk variant of addTag — adds a single tag id to many conversations at once.
   * Tenant-scoped: only conversations belonging to `tenantId` are updated.
   */
  async addTagToMany(
    conversationIds: string[],
    tenantId: string,
    tagId: string,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const result = await this.model
      .updateMany(
        { _id: { $in: conversationIds }, tenantId },
        { $addToSet: { tags: tagId } },
      )
      .exec();

    return {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
    };
  }

  async claimConversation(
    id: string,
    agentId: string,
  ): Promise<OmniConversation | null> {
    const now = new Date();
    const doc = await this.model
      .findByIdAndUpdate(
        id,
        [
          {
            $set: {
              claimedById: agentId,
              claimedAt: now,
              ...this.ownershipTiming(agentId, now),
            },
          },
        ],
        { new: true },
      )
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  async resetUnreadCount(id: string): Promise<void> {
    await this.model.findByIdAndUpdate(id, { unreadCount: 0 }).exec();
  }

  /**
   * Update the assigned agent for a conversation, and optionally the owning
   * group in the same write.
   *
   * `groupId` is written whenever it is not undefined — including `null`, which
   * clears the group. Agent and group must move together: a conversation left
   * pointing at the group of a previous routing decision is visible to the
   * wrong team lead.
   */
  async updateAssignment(
    id: string,
    agentId: string | null,
    groupId?: string | null,
  ): Promise<OmniConversation | null> {
    const set: Record<string, unknown> = this.ownershipTiming(
      agentId,
      new Date(),
    );
    if (groupId !== undefined) set.assignedGroupId = groupId;
    const doc = await this.model
      .findByIdAndUpdate(id, [{ $set: set }], { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Conditional reassignment: only succeeds when the conversation's current
   * `assignedAgentId` still equals `expectedPreviousAgentId`.
   *
   * This is the CAS primitive `reassign()` was missing — `updateAssignment()`
   * writes unconditionally, so two concurrent reassignment decisions (e.g. a
   * duplicated reopen-triggered webhook) could both "succeed", the loser's
   * reservation never released. Passing `null` means "only if still
   * unassigned", the same guarantee as `assignIfUnassigned`.
   */
  async reassignIfExpected(
    id: string,
    agentId: string | null,
    groupId: string | null | undefined,
    expectedPreviousAgentId: string | null,
  ): Promise<OmniConversation | null> {
    const set: Record<string, unknown> = this.ownershipTiming(
      agentId,
      new Date(),
    );
    if (groupId !== undefined) set.assignedGroupId = groupId;
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, assignedAgentId: expectedPreviousAgentId },
        [{ $set: set }],
        { new: true },
      )
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Optimistic assignment used by the auto-assignment hot path.
   * It only succeeds when the conversation is still active and unassigned.
   */
  async assignIfUnassigned(
    id: string,
    agentId: string,
    groupId?: string | null,
  ): Promise<OmniConversation | null> {
    const set: Record<string, unknown> = this.ownershipTiming(
      agentId,
      new Date(),
    );
    if (groupId !== undefined) set.assignedGroupId = groupId;
    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: id,
          status: { $in: ['open', 'pending'] },
          $or: [
            { assignedAgentId: null },
            { assignedAgentId: { $exists: false } },
          ],
        },
        [{ $set: set }],
        { new: true },
      )
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Update the assigned group for a conversation.
   */
  async updateGroupAssignment(
    id: string,
    groupId: string | null,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findByIdAndUpdate(id, { assignedGroupId: groupId }, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Update the cached customer profile (name, avatarUrl) fetched from the platform.
   * Used after creating a new conversation to enrich the display information.
   */
  async updateCustomerProfile(
    id: string,
    profile: { name?: string; avatarUrl?: string },
  ): Promise<void> {
    const update: Record<string, any> = {};
    if (profile.name) update['customer.name'] = profile.name;
    if (profile.avatarUrl) update['customer.avatarUrl'] = profile.avatarUrl;
    if (Object.keys(update).length === 0) return;
    await this.model.findByIdAndUpdate(id, { $set: update }).exec();
  }

  async updateCustomerInfo(
    id: string,
    info: { email?: string; phone?: string; name?: string },
  ): Promise<OmniConversation | null> {
    const update: Record<string, any> = {};
    if (info.email !== undefined) update['customer.email'] = info.email;
    if (info.phone !== undefined) update['customer.phone'] = info.phone;
    if (info.name !== undefined) update['customer.name'] = info.name;

    if (Object.keys(update).length === 0) return null;

    const doc = await this.model
      .findByIdAndUpdate(id, { $set: update }, { new: true })
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  async updateContactId(id: string, contactId: string): Promise<void> {
    await this.model.findByIdAndUpdate(id, { $set: { contactId } }).exec();
  }

  /**
   * Propagate a contact's VIP flag onto its conversations.
   *
   * Bounded to conversations that are still open or pending on purpose: a
   * resolved thread from last year does not become VIP retroactively, its
   * routing decision is already made, and leaving it alone keeps this write
   * proportional to the agent's live queue rather than to the contact's whole
   * history.
   *
   * Runs as a platform query: the trigger is a contact update that may come from
   * an import worker or a cron with no request context, and a tenant-plugin
   * throw there would silently leave the flag unsynced — the exact failure this
   * method exists to end.
   */
  async syncVipForContact(params: {
    tenantId: string;
    contactId: string;
    isVip: boolean;
  }): Promise<number> {
    const result = await this.model
      .updateMany(
        {
          tenantId: new Types.ObjectId(params.tenantId),
          contactId: new Types.ObjectId(params.contactId),
          status: { $in: ['open', 'pending'] },
          isVip: { $ne: params.isVip },
        },
        { $set: { isVip: params.isVip } },
      )
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
    return result.modifiedCount ?? 0;
  }

  /**
   * Find ALL conversations for a given customer thread (any status), sorted oldest-first.
   * Used for cross-conversation message history.
   */
  async findAllByExternalId(
    tenantId: string,
    channelType: string,
    channelAccount: string,
    externalId: string,
    limit = 100,
  ): Promise<OmniConversation[]> {
    const docs = await this.model
      .find({ tenantId, channelType, channelAccount, externalId })
      .sort({ createdAt: 1 })
      .limit(limit + 1)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .lean()
      .exec();

    if (docs.length > limit) {
      this.logger.warn(
        `findAllByExternalId truncated: ${docs.length} sessions for ` +
          `${channelType}/${externalId} (limit=${limit})`,
      );
      docs.length = limit; // truncate in-place
    }

    return docs.map((doc) => OmniConversationMapper.toDomain(doc as any));
  }

  async findThreadSessionsAroundAnchor(params: {
    thread: ThreadIdentity;
    anchor: ConversationTimelineCursor;
    pastLimit: number;
    futureLimit: number;
  }): Promise<{ past: ThreadSessionSlice; future: ThreadSessionSlice }> {
    const [past, future] = await Promise.all([
      this.findPastSessionsByCursor({
        ...params.thread,
        cursor: params.anchor,
        limit: params.pastLimit,
      }),
      this.findFutureSessionsByCursor({
        ...params.thread,
        cursor: params.anchor,
        limit: params.futureLimit,
      }),
    ]);

    return { past, future };
  }

  async findPastSessionsByCursor(params: {
    tenantId: string;
    channelType: string;
    channelAccount: string;
    externalId: string;
    cursor: ConversationTimelineCursor;
    limit: number;
  }): Promise<ThreadSessionSlice> {
    const safeLimit = Math.max(1, Math.min(params.limit, 50));
    const filter = {
      tenantId: params.tenantId,
      channelType: params.channelType,
      channelAccount: params.channelAccount,
      externalId: params.externalId,
      ...this.buildDirectionalCursorFilter('past', params.cursor),
    };

    const docs = await this.model
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(safeLimit + 1)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .exec();

    const hasMore = docs.length > safeLimit;
    const trimmed = hasMore ? docs.slice(0, safeLimit) : docs;
    const ordered = [...trimmed].reverse();
    const sessions = ordered.map((doc) => OmniConversationMapper.toDomain(doc));
    const oldest = sessions[0] ?? null;

    return {
      sessions,
      hasMore,
      cursor: oldest
        ? {
            createdAt: oldest.createdAt,
            id: oldest.id,
          }
        : null,
    };
  }

  async findFutureSessionsByCursor(params: {
    tenantId: string;
    channelType: string;
    channelAccount: string;
    externalId: string;
    cursor: ConversationTimelineCursor;
    limit: number;
  }): Promise<ThreadSessionSlice> {
    const safeLimit = Math.max(1, Math.min(params.limit, 50));
    const filter = {
      tenantId: params.tenantId,
      channelType: params.channelType,
      channelAccount: params.channelAccount,
      externalId: params.externalId,
      ...this.buildDirectionalCursorFilter('future', params.cursor),
    };

    const docs = await this.model
      .find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(safeLimit + 1)
      .populate('assignedAgent')
      .populate('resolvedByAgent')
      .exec();

    const hasMore = docs.length > safeLimit;
    const trimmed = hasMore ? docs.slice(0, safeLimit) : docs;
    const sessions = trimmed.map((doc) => OmniConversationMapper.toDomain(doc));
    const newest = sessions[sessions.length - 1] ?? null;

    return {
      sessions,
      hasMore,
      cursor: newest
        ? {
            createdAt: newest.createdAt,
            id: newest.id,
          }
        : null,
    };
  }

  /**
   * Count open/pending conversations assigned to a specific agent.
   * Used by the least-busy assignment strategy.
   */
  async countOpenByAgent(tenantId: string, agentId: string): Promise<number> {
    if (!Types.ObjectId.isValid(agentId)) return 0;
    return this.model
      .countDocuments({
        tenantId,
        assignedAgentId: agentId,
        status: { $in: ['open', 'pending'] },
      })
      .setOptions({ isPlatformQuery: true })
      .exec();
  }

  /**
   * Whether any open/pending conversation is waiting with no agent, for a
   * tenant. Used by the dead-queue alert (zero agents online) — an
   * existence check via `.limit(1)`, not a count, so it stays cheap
   * regardless of how deep the queue actually is.
   */
  async existsUnassignedOpen(tenantId: string): Promise<boolean> {
    const doc = await this.model
      .findOne(
        {
          tenantId,
          assignedAgentId: null,
          status: { $in: ['open', 'pending'] },
        },
        { _id: 1 },
      )
      .setOptions({ isPlatformQuery: true })
      .lean()
      .exec();
    return !!doc;
  }

  /**
   * Batch-count open/pending conversations for multiple agents in a single
   * aggregation pipeline. Eliminates N+1 queries in assignment strategies.
   *
   * Returns a Map<agentId, count>. Agents with zero open conversations
   * will NOT appear in the map — callers should default to 0.
   */
  async countOpenByAgents(
    tenantId: string,
    agentIds: string[],
  ): Promise<Map<string, number>> {
    const validIds = agentIds.filter((id) => Types.ObjectId.isValid(id));
    if (validIds.length === 0) return new Map();

    const results = await this.model
      .aggregate<{
        _id: string;
        count: number;
      }>([
        {
          $match: {
            tenantId: new Types.ObjectId(tenantId),
            assignedAgentId: {
              $in: validIds.map((id) => new Types.ObjectId(id)),
            },
            status: { $in: ['open', 'pending'] },
          },
        },
        {
          $group: {
            _id: '$assignedAgentId',
            count: { $sum: 1 },
          },
        },
      ])
      .option({ isPlatformQuery: true });

    const map = new Map<string, number>();
    for (const row of results) {
      map.set(row._id.toString(), row.count);
    }
    return map;
  }

  /**
   * Reopen a resolved conversation: set status back to 'open',
   * increment reopenCount, clear resolve metadata, and reset bot session
   * context so the bot starts fresh (while preserving the enabled flag).
   */
  async reopenConversation(
    conversationId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: conversationId, status: 'resolved' },
        {
          $set: {
            status: 'open',
            resolvedByAgentId: null,
            resolvedAt: null,
            resolveReason: null,
            resolveNote: null,
            resolveSource: null,
            // Reset bot session context — fresh start on reopen
            'bot.sessionId': null,
            'bot.flowId': null,
            'bot.status': 'active',
            'bot.lastError': null,
          },
          $inc: { reopenCount: 1 },
        },
        { new: true },
      )
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc) : null;
  }

  /**
   * Find the most recently resolved/closed conversation for a contact.
   * Used by sticky routing to find the agent who last handled this customer.
   */
  async findLastResolvedByContact(
    tenantId: string,
    contactId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOne({
        tenantId,
        contactId,
        status: { $in: ['resolved', 'closed'] },
        assignedAgentId: { $ne: null },
      })
      .sort({ resolvedAt: -1, updatedAt: -1 })
      .lean()
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc as any) : null;
  }

  /**
   * Find the most recently resolved/closed conversation for an external sender.
   * Fallback for sticky routing when contactId is not available.
   */
  async findLastResolvedBySender(
    tenantId: string,
    externalSenderId: string,
  ): Promise<OmniConversation | null> {
    const doc = await this.model
      .findOne({
        tenantId,
        'customer.externalId': externalSenderId,
        status: { $in: ['resolved', 'closed'] },
        assignedAgentId: { $ne: null },
      })
      .sort({ resolvedAt: -1, updatedAt: -1 })
      .lean()
      .exec();
    return doc ? OmniConversationMapper.toDomain(doc as any) : null;
  }

  /**
   * Find all open/pending conversations assigned to a specific agent.
   * Used by AgentFallbackService to reassign conversations when an agent goes offline.
   */
  async findOpenByAgent(
    tenantId: string,
    agentId: string,
  ): Promise<OmniConversation[]> {
    if (!Types.ObjectId.isValid(agentId)) return [];
    const docs = await this.model
      .find({
        tenantId,
        assignedAgentId: agentId,
        status: { $in: ['open', 'pending'] },
      })
      .sort({ lastMessageAt: -1 })
      .lean()
      .exec();
    return docs.map((doc) => OmniConversationMapper.toDomain(doc as any));
  }

  private buildDirectionalCursorFilter(
    direction: 'past' | 'future',
    cursor: ConversationTimelineCursor,
  ): FilterQuery<OmniConversationDocument> {
    const cursorId = Types.ObjectId.isValid(cursor.id)
      ? new Types.ObjectId(cursor.id)
      : null;

    if (!cursorId) {
      return {
        createdAt:
          direction === 'past'
            ? { $lt: cursor.createdAt }
            : { $gt: cursor.createdAt },
      };
    }

    if (direction === 'past') {
      return {
        $or: [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: cursorId } },
        ],
      };
    }

    return {
      $or: [
        { createdAt: { $gt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $gt: cursorId } },
      ],
    };
  }

  /**
   * The channel and owner of a conversation, for deciding who may receive its
   * realtime events.
   *
   * Deliberately bypasses the reader's own visibility scope: this answers "who is
   * allowed to see this record", so it has to read the record's real channel and
   * assignee, not the caller's filtered view of them. Tenant isolation still
   * applies through the schema plugin.
   */
  async findAuthorizationFacts(
    tenantId: string,
    conversationId: string,
  ): Promise<{
    channelId: string | null;
    assignedAgentId: string | null;
  } | null> {
    // `tenantId` is passed rather than read from CLS: the caller is a Redis
    // pub/sub handler with no request context, and a query that silently loses
    // its tenant predicate is the one mistake this collection cannot afford.
    const doc = await this.model
      .findOne({ _id: conversationId, tenantId })
      .select('channelId assignedAgentId')
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();
    if (!doc) return null;
    return {
      channelId: doc.channelId ? String(doc.channelId) : null,
      assignedAgentId: doc.assignedAgentId ? String(doc.assignedAgentId) : null,
    };
  }

  /**
   * Record the agent's first reply — once, and only once.
   *
   * The `firstRespondedAt: null` guard is what makes "first" true: an agent may
   * send several messages in the same second and the reply path is concurrent, so
   * an unconditional write would keep moving the timestamp forward and First
   * Response Time would measure the *latest* reply.
   *
   * @returns whether this call was the one that recorded it.
   */
  async recordFirstResponse(
    conversationId: string,
    respondedAt: Date,
    responderId: string | null,
  ): Promise<boolean> {
    const result = await this.model
      .updateOne(
        { _id: conversationId, firstRespondedAt: null },
        {
          $set: {
            firstRespondedAt: respondedAt,
            firstResponderId: responderId,
          },
        },
      )
      .exec();
    return result.modifiedCount > 0;
  }

  /**
   * Live queue depth and wait time, grouped by owning team.
   *
   * One aggregation over the partial `conversation_queue_wait` index, which holds
   * only rows with a `queuedAt` — a few, not the collection. Visibility scope is
   * applied, so a team lead sees their own queues and a tenant admin sees all of
   * them, matching what the same principal can read in the inbox.
   */
  async aggregateQueueDepth(tenantId: string): Promise<
    Array<{
      groupId: string | null;
      depth: number;
      oldestQueuedAt: Date | null;
      totalWaitMs: number;
      breachedCount: number;
      byChannel: Array<{ channelType: string; depth: number }>;
    }>
  > {
    const now = new Date();
    const filter: FilterQuery<OmniConversationDocument> = {
      tenantId,
      status: { $in: ['open', 'pending'] },
      assignedAgentId: null,
      queuedAt: { $ne: null },
    };
    this.applyVisibilityScope(filter);

    const rows = await this.model
      .aggregate([
        { $match: filter },
        {
          $group: {
            _id: { group: '$assignedGroupId', channel: '$channelType' },
            depth: { $sum: 1 },
            oldestQueuedAt: { $min: '$queuedAt' },
            totalWaitMs: { $sum: { $subtract: [now, '$queuedAt'] } },
            breachedCount: {
              $sum: { $cond: [{ $eq: ['$slaBreached', true] }, 1, 0] },
            },
          },
        },
        {
          $group: {
            _id: '$_id.group',
            depth: { $sum: '$depth' },
            oldestQueuedAt: { $min: '$oldestQueuedAt' },
            totalWaitMs: { $sum: '$totalWaitMs' },
            breachedCount: { $sum: '$breachedCount' },
            byChannel: {
              $push: { channelType: '$_id.channel', depth: '$depth' },
            },
          },
        },
      ])
      .exec();

    return rows.map((row: any) => ({
      groupId: row._id ? String(row._id) : null,
      depth: row.depth,
      oldestQueuedAt: row.oldestQueuedAt ?? null,
      totalWaitMs: row.totalWaitMs ?? 0,
      breachedCount: row.breachedCount ?? 0,
      byChannel: (row.byChannel ?? []).map((entry: any) => ({
        channelType: String(entry.channelType ?? 'unknown'),
        depth: entry.depth,
      })),
    }));
  }

  /**
   * Project SLA clock state onto the conversation so the inbox can filter and
   * sort on it without joining `omni_sla_clocks`.
   *
   * `slaBreached` is deliberately sticky: once a conversation has missed a
   * deadline that stays true for the rest of its life, which is what a supervisor
   * filtering "breached today" means. Only the *pending* deadline moves.
   */
  async projectSlaState(
    conversationId: string,
    state: {
      slaDueAt?: Date | null;
      slaDueMetric?: string | null;
      /** A date marks a breach; `null` clears the flag on reopen. */
      breachedAt?: Date | null;
    },
  ): Promise<void> {
    // Key-by-key: the engine records a policy id, a deadline and a breach on
    // different occasions, and writing the whole shape every time would blank
    // the deadline each time one of the others was recorded.
    const set: Record<string, unknown> = {};
    if ('slaDueAt' in state) set.slaDueAt = state.slaDueAt;
    if ('slaDueMetric' in state) set.slaDueMetric = state.slaDueMetric;
    if ('breachedAt' in state) {
      set.slaBreached = state.breachedAt !== null;
      set.slaBreachedAt = state.breachedAt;
    }
    if (Object.keys(set).length === 0) return;
    await this.model.updateOne({ _id: conversationId }, { $set: set }).exec();
  }

  /**
   * Get all distinct tenant IDs that have at least one open or pending conversation.
   * Used by the auto-resolve cron to know which tenants to scan.
   */
  async findDistinctTenantIdsWithActiveConversations(): Promise<string[]> {
    const tenantIds = await this.model
      .find({ status: { $in: ['open', 'pending'] } })
      .distinct('tenantId')
      .setOptions({ isPlatformQuery: true })
      .exec();
    return tenantIds.map((id) => id.toString());
  }

  /**
   * Find open/pending conversations where lastMessageAt is older than the cutoff date.
   * Used by auto-resolve to identify conversations that should be auto-resolved.
   */
  async findIdleConversations(
    tenantId: string,
    lastMessageBefore: Date,
  ): Promise<OmniConversation[]> {
    const docs = await this.model
      .find({
        tenantId,
        status: { $in: ['open', 'pending'] },
        $or: [
          { lastMessageAt: { $lte: lastMessageBefore } },
          { lastMessageAt: null, createdAt: { $lte: lastMessageBefore } },
        ],
      })
      .limit(100) // Process in batches to avoid memory issues
      .exec();
    return docs.map(OmniConversationMapper.toDomain);
  }

  /**
   * The ids of a contact's conversations the caller is allowed to see.
   *
   * Exists so message search can bound its work to a set of threads without
   * loading the threads themselves. It goes through `applyVisibilityScope` for
   * the same reason `findByContactId` had to be fixed to: without it, anyone
   * holding `view:omni_channel` could reach conversations on a restricted
   * channel, or belonging to an agent outside their scope, simply by passing a
   * contact id.
   *
   * `limit` is a hard bound, not a page: a contact with a thousand threads must
   * not turn one search into a thousand-thread scan. Newest threads first,
   * because that is where a recent mention is.
   */
  async findScopedConversationIdsForContact(params: {
    tenantId: string;
    contactId: string;
    limit: number;
  }): Promise<string[]> {
    if (!Types.ObjectId.isValid(params.contactId)) return [];
    const filter: FilterQuery<OmniConversationDocument> = {
      tenantId: params.tenantId,
      contactId: new Types.ObjectId(params.contactId),
    };
    this.applyVisibilityScope(filter);

    const docs = await this.model
      .find(filter)
      .select({ _id: 1 })
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(Math.max(1, Math.min(params.limit, 200)))
      .lean()
      .exec();
    return docs.map((doc: any) => String(doc._id));
  }

  /**
   * Find all conversations linked to a specific CRM contact.
   * Used by Contact Detail → "Conversations" tab to show omni history.
   */
  async findByContactId(
    tenantId: string,
    contactId: string,
    page: number,
    limit: number,
  ): Promise<PaginationResponseDto<OmniConversation>> {
    const filter: FilterQuery<OmniConversationDocument> = {
      tenantId,
      contactId,
    };
    // This lookup used to skip applyVisibilityScope entirely, so any
    // principal with view:omni_channel could read every conversation for a
    // contact via ?contactId=, including ones on a restricted channel they
    // are not in the support pool for, and ones owned by someone outside
    // their scope. Same enforcement as the main list/detail paths.
    this.applyVisibilityScope(filter);
    const sort: Record<string, SortOrder> = { lastMessageAt: -1 };

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const skip = (safePage - 1) * safeLimit;

    const [items, { totalItems: total }] = await Promise.all([
      this.model
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(safeLimit)
        .populate('assignedAgent')
        .populate('resolvedByAgent')
        .lean()
        .exec(),
      cappedCount(this.model as Model<any>, filter),
    ]);

    const mappedItems = items.map((doc) =>
      OmniConversationMapper.toDomain(doc as any),
    );

    return pagination(mappedItems, total, { page: safePage, limit: safeLimit });
  }

  // Aggregate Methods (Phase 1)

  /**
   * Atomically allocate the next sequence number for a conversation.
   * Called inside the ConversationOpsProcessor lock — guarantees monotonic
   * ordering even under concurrent access.
   */
  async getNextSequence(conversationId: string): Promise<number> {
    const doc = await this.model.findOneAndUpdate(
      { _id: conversationId },
      { $inc: { nextSequence: 1 } },
      { returnDocument: 'after', projection: { nextSequence: 1 } },
    );
    return doc?.nextSequence ?? 1;
  }

  /**
   * Apply an arbitrary Mongoose update expression to a conversation.
   * This is the single entry point for all aggregate-level mutations
   * from ConversationOpsProcessor.
   *
   * Accepts raw $set, $inc, $unset — the processor builds the correct
   * update expression based on the command being processed.
   */
  /**
   * Conversations that are still open but have been silent past their
   * auto-resolve deadline — i.e. ones whose timer should already have fired.
   *
   * In a healthy system this returns nothing; a non-empty result means the
   * delayed jobs holding those timers were lost.
   */
  async findOverdueForAutoResolve(
    silentSince: Date,
    limit: number,
  ): Promise<Array<{ tenantId: string; conversationId: string }>> {
    const docs = await this.model
      .find({
        status: { $in: ['open', 'pending'] },
        lastMessageAt: { $lte: silentSince },
      })
      .select('_id tenantId')
      .sort({ lastMessageAt: 1 })
      .limit(limit)
      .lean()
      .setOptions({ isPlatformQuery: true })
      .exec();

    return docs.map((doc: any) => ({
      tenantId: String(doc.tenantId),
      conversationId: String(doc._id),
    }));
  }

  async atomicUpdate(
    conversationId: string,
    update: Record<string, any>,
  ): Promise<void> {
    await this.model.findByIdAndUpdate(conversationId, update).exec();
  }

  /**
   * Fold a newly persisted message into the conversation aggregate.
   *
   * Counters always advance; the `lastMessage*` summary only advances when this
   * message is newer than the one currently summarised. Both happen in one
   * round trip via an aggregation-pipeline update, so a replayed or late
   * message can never rewind the inbox row it is displayed in.
   */
  async applyIncomingMessage(
    conversationId: string,
    change: {
      sequence: number;
      counters: { messageCount: number; unreadCount: number };
      preview: Record<string, unknown>;
    },
  ): Promise<void> {
    const isNewer = {
      $gte: [change.sequence, { $ifNull: ['$lastMessageSequence', 0] }],
    };
    const advanceIfNewer = Object.fromEntries(
      Object.entries(change.preview).map(([field, value]) => [
        field,
        { $cond: [isNewer, value, `$${field}`] },
      ]),
    );

    await this.model
      .updateOne({ _id: conversationId }, [
        {
          $set: {
            ...advanceIfNewer,
            lastMessageSequence: {
              $cond: [
                isNewer,
                change.sequence,
                { $ifNull: ['$lastMessageSequence', 0] },
              ],
            },
            messageCount: {
              $add: [
                { $ifNull: ['$messageCount', 0] },
                change.counters.messageCount,
              ],
            },
            unreadCount: {
              $add: [
                { $ifNull: ['$unreadCount', 0] },
                change.counters.unreadCount,
              ],
            },
          },
        },
      ])
      .exec();
  }
}
