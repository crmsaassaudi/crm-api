import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { ContactRepository } from '../infrastructure/persistence/document/repositories/contact.repository';
import { AuthzPermissionCacheService } from '../../common/permissions/authz-permission-cache.service';
import { buildVisibilityClauses } from '../../common/permissions/visibility-scope';

/** Sources a contact's history is scattered across. */
export type TimelineSource =
  | 'activity'
  | 'note'
  | 'ticket'
  | 'deal'
  | 'task'
  | 'conversation'
  | 'stage_change';

export interface TimelineEntry {
  id: string;
  source: TimelineSource;
  /** Finer-grained kind within the source, e.g. the activity event name. */
  type: string;
  occurredAt: Date;
  actorId?: string | null;
  /** One-line human summary; the client renders this without extra lookups. */
  title: string;
  /** Source-specific extras (status, amount, stage names…). */
  meta: Record<string, unknown>;
  /** Where clicking through should go, when the entry has its own record. */
  link?: { type: string; id: string };
}

/** Per-source fetch cap. Kept modest — this is a feed, not an export. */
const SOURCE_LIMIT = 50;

/**
 * What a caller must hold to see each source, and which module's visibility
 * scope its rows are filtered by.
 *
 * The feed reads five other modules' collections on the raw connection, which
 * bypasses both `@RequirePermission` and the repository's `applyTenantFilter` —
 * so it enforces the per-tab endpoints' own gates here. Consolidating seven tabs
 * must not consolidate away their authorization.
 *
 * `scopeModule: null` means the rows carry no ownership of their own and are
 * governed by the contact the caller already passed the ACL for.
 */
const SOURCE_AUTHZ: Record<
  TimelineSource,
  {
    permission: { action: string; resource: string } | null;
    scopeModule: string | null;
  }
> = {
  activity: { permission: null, scopeModule: null },
  note: { permission: null, scopeModule: null },
  stage_change: { permission: null, scopeModule: null },
  ticket: {
    permission: { action: 'view', resource: 'tickets' },
    scopeModule: 'Ticket',
  },
  deal: {
    permission: { action: 'view', resource: 'deals' },
    scopeModule: 'Deal',
  },
  task: {
    permission: { action: 'view', resource: 'tasks' },
    scopeModule: 'Task',
  },
  conversation: {
    permission: { action: 'view', resource: 'omni_channel' },
    scopeModule: 'Conversation',
  },
};

/**
 * ContactTimelineService — one chronological answer to "what happened with this
 * person?".
 *
 * Before this, the contact detail page asked seven separate questions: one query
 * each for activities, notes, deals, tickets, tasks, conversations and the audit
 * trail, rendered as seven tabs and stitched together only in the user's head.
 * That is N+1 by construction (seven round-trips per contact opened) and it means
 * the single most-used screen in a CRM — the unified customer history that
 * Salesforce, HubSpot, Zendesk and EspoCRM all lead with — did not exist.
 *
 * A QUERY-TIME fan-in, not a `contact_timeline` collection. That collection is
 * the right end state at 100M contacts; the endpoint contract does not change
 * when it arrives, only what this method reads from.
 *
 * The per-source caps are the honest limitation: the most recent `SOURCE_LIMIT`
 * of each source, merged and trimmed, not a true global cursor.
 * `truncatedSources` reports which sources were capped rather than presenting a
 * partial feed as complete.
 */
@Injectable()
export class ContactTimelineService {
  private readonly logger = new Logger(ContactTimelineService.name);

  constructor(
    private readonly contacts: ContactRepository,
    private readonly cls: ClsService,
    private readonly authzCache: AuthzPermissionCacheService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async getTimeline(
    contactId: string,
    options: {
      limit?: number;
      sources?: TimelineSource[];
      before?: Date;
    } = {},
  ): Promise<{
    data: TimelineEntry[];
    truncatedSources: TimelineSource[];
    sourceCounts: Record<string, number>;
    deniedSources: TimelineSource[];
    nextCursor?: string;
    hasNextPage: boolean;
  }> {
    // Read the contact through the repository first: that applies the tenant and
    // visibility axes, so the timeline cannot become a side door to a record the
    // caller may not see.
    const contact = await this.contacts.findOne({ _id: contactId });
    if (!contact) throw new NotFoundException('Contact not found');

    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const requested = new Set<TimelineSource>(
      options.sources && options.sources.length > 0
        ? options.sources
        : (Object.keys(SOURCE_AUTHZ) as TimelineSource[]),
    );

    // Drop the sources this caller may not read, and say so: a feed that is
    // silently short reads as "nothing happened", which is a different and worse
    // answer than "you cannot see this part".
    const granted = await this.grantedPermissions();
    const deniedSources = [...requested].filter((source) => {
      const rule = SOURCE_AUTHZ[source].permission;
      return rule ? !granted.has(`${rule.resource}:${rule.action}`) : false;
    });
    const wanted = new Set(
      [...requested].filter((source) => !deniedSources.includes(source)),
    );

    const oid = new Types.ObjectId(contactId);

    const results = await Promise.all([
      wanted.has('activity')
        ? this.fetchActivities(contactId, options.before)
        : empty(),
      wanted.has('note') ? this.fetchNotes(oid, options.before) : empty(),
      wanted.has('ticket') ? this.fetchTickets(oid, options.before) : empty(),
      wanted.has('deal') ? this.fetchDeals(oid, options.before) : empty(),
      wanted.has('task') ? this.fetchTasks(contactId, options.before) : empty(),
      wanted.has('conversation')
        ? this.fetchConversations(oid, options.before)
        : empty(),
      wanted.has('stage_change')
        ? this.fetchStageTransitions(oid, options.before)
        : empty(),
    ]);

    // Stage history is embedded on the contact we already loaded — no query.
    const projectedStages = results.at(-1) ?? [];
    const stageEntries =
      wanted.has('stage_change') && projectedStages.length === 0
        ? this.mapStageHistory(contact).filter(
            (entry) =>
              !options.before ||
              new Date(entry.occurredAt).getTime() < options.before.getTime(),
          )
        : [];

    const merged = [...results.flat(), ...stageEntries].sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );

    const sourceCounts: Record<string, number> = {};
    for (const entry of merged) {
      sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
    }

    // Which sources hit the cap — surfaced rather than hidden, so "no more
    // entries" and "we stopped looking" are distinguishable in the UI.
    const truncatedSources = (
      Object.entries(sourceCounts) as [TimelineSource, number][]
    )
      .filter(([, count]) => count >= SOURCE_LIMIT)
      .map(([source]) => source);

    const data = merged.slice(0, limit);
    const hasNextPage = merged.length > limit || truncatedSources.length > 0;
    return {
      data,
      truncatedSources,
      sourceCounts,
      deniedSources,
      hasNextPage,
      nextCursor:
        hasNextPage && data.length > 0
          ? new Date(data[data.length - 1].occurredAt).toISOString()
          : undefined,
    };
  }

  // Per-source fetchers
  //
  // Raw-connection reads by collection name, like the merge registry: pulling
  // Tickets/Deals/OmniInbound services in here would recreate the dependency
  // cycles ContactsModule already avoids. Each is projected down to the few
  // fields the feed renders — a timeline must never drag whole documents across.

  private async fetchActivities(
    contactId: string,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('activity_logs', 'activity', {
      filter: {
        targetType: 'contact',
        targetId: contactId,
        ...beforeDate('occurredAt', before),
      },
      projection: { event: 1, actorId: 1, occurredAt: 1, payload: 1 },
      sort: { occurredAt: -1 },
    });

    return rows.map((row) => ({
      id: String(row._id),
      source: 'activity' as const,
      type: String(row.event ?? 'activity'),
      occurredAt: row.occurredAt,
      actorId: row.actorId ? String(row.actorId) : null,
      title: String(row.event ?? 'activity'),
      meta: (row.payload as Record<string, unknown>) ?? {},
    }));
  }

  private async fetchNotes(
    contactId: Types.ObjectId,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('notes', 'note', {
      filter: {
        contactId,
        ...beforeDate('createdAt', before),
      },
      projection: { title: 1, content: 1, createdById: 1, createdAt: 1 },
      sort: { createdAt: -1 },
    });

    return rows.map((row) => ({
      id: String(row._id),
      source: 'note' as const,
      type: 'note',
      occurredAt: row.createdAt,
      actorId: row.createdById ? String(row.createdById) : null,
      title: String(row.title || excerpt(row.content) || 'Note'),
      meta: { excerpt: excerpt(row.content) },
      link: { type: 'note', id: String(row._id) },
    }));
  }

  private async fetchTickets(
    contactId: Types.ObjectId,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('tickets', 'ticket', {
      filter: {
        contactId,
        deletedAt: null,
        ...beforeDate('createdAt', before),
      },
      projection: {
        subject: 1,
        title: 1,
        statusId: 1,
        priority: 1,
        createdById: 1,
        createdAt: 1,
      },
      sort: { createdAt: -1 },
    });

    return rows.map((row) => ({
      id: String(row._id),
      source: 'ticket' as const,
      type: 'ticket_created',
      occurredAt: row.createdAt,
      actorId: row.createdById ? String(row.createdById) : null,
      title: String(row.subject ?? row.title ?? 'Ticket'),
      meta: { statusId: row.statusId, priority: row.priority },
      link: { type: 'ticket', id: String(row._id) },
    }));
  }

  private async fetchDeals(
    contactId: Types.ObjectId,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('deals', 'deal', {
      filter: {
        contactIds: contactId,
        deletedAt: null,
        ...beforeDate('createdAt', before),
      },
      projection: {
        name: 1,
        title: 1,
        amount: 1,
        stageId: 1,
        createdById: 1,
        createdAt: 1,
      },
      sort: { createdAt: -1 },
    });

    return rows.map((row) => ({
      id: String(row._id),
      source: 'deal' as const,
      type: 'deal_created',
      occurredAt: row.createdAt,
      actorId: row.createdById ? String(row.createdById) : null,
      title: String(row.name ?? row.title ?? 'Deal'),
      meta: { amount: row.amount, stageId: row.stageId },
      link: { type: 'deal', id: String(row._id) },
    }));
  }

  private async fetchTasks(
    contactId: string,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('tasks', 'task', {
      filter: {
        'relatedTo.type': 'Contact',
        // Both key shapes, matching TaskRepository — older rows use `.id`.
        $or: [{ 'relatedTo._id': contactId }, { 'relatedTo.id': contactId }],
        deletedAt: null,
        ...beforeDate('createdAt', before),
      },
      projection: {
        title: 1,
        subject: 1,
        statusId: 1,
        dueDate: 1,
        completedAt: 1,
        createdById: 1,
        createdAt: 1,
      },
      sort: { createdAt: -1 },
    });

    return rows.map((row) => ({
      id: String(row._id),
      source: 'task' as const,
      // A completed task is a different event from an open one, and the feed is
      // about what happened, not what is outstanding.
      type: row.completedAt ? 'task_completed' : 'task_created',
      occurredAt: row.completedAt ?? row.createdAt,
      actorId: row.createdById ? String(row.createdById) : null,
      title: String(row.title ?? row.subject ?? 'Task'),
      meta: { statusId: row.statusId, dueDate: row.dueDate },
      link: { type: 'task', id: String(row._id) },
    }));
  }

  private async fetchConversations(
    contactId: Types.ObjectId,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('omni_conversations', 'conversation', {
      filter: {
        contactId,
        ...beforeDate('lastMessageAt', before),
      },
      projection: {
        channelType: 1,
        status: 1,
        assignedAgentId: 1,
        lastMessageAt: 1,
        createdAt: 1,
      },
      sort: { createdAt: -1 },
    });

    return rows.map((row) => ({
      id: String(row._id),
      source: 'conversation' as const,
      type: 'conversation',
      occurredAt: row.lastMessageAt ?? row.createdAt,
      actorId: row.assignedAgentId ? String(row.assignedAgentId) : null,
      title: `${String(row.channelType ?? 'chat')} conversation`,
      meta: { channelType: row.channelType, status: row.status },
      link: { type: 'conversation', id: String(row._id) },
    }));
  }

  /**
   * Stage transitions, from the array already on the loaded contact.
   *
   * These are "virtual activities" — the audit notes they are intentionally not
   * written to `activity_logs` because the diff is already in the audit trail.
   * Folding them in here is what makes the feed a lifecycle story rather than a
   * list of attachments.
   */
  private async fetchStageTransitions(
    contactId: Types.ObjectId,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('contact_stage_transitions', 'stage_change', {
      filter: {
        contactId,
        ...beforeDate('occurredAt', before),
      },
      projection: {
        fromStage: 1,
        toStage: 1,
        occurredAt: 1,
        changedById: 1,
        reason: 1,
        direction: 1,
        skippedStages: 1,
      },
      sort: { occurredAt: -1 },
    });

    return rows.map((row) => ({
      id: String(row._id),
      source: 'stage_change' as const,
      type: 'stage_change',
      occurredAt: row.occurredAt,
      actorId: row.changedById ? String(row.changedById) : null,
      title: row.fromStage
        ? `${String(row.fromStage)} → ${String(row.toStage)}`
        : `Entered ${String(row.toStage)}`,
      meta: {
        fromStage: row.fromStage,
        toStage: row.toStage,
        direction: row.direction,
        reason: row.reason,
        skippedStages: row.skippedStages,
      },
    }));
  }

  private mapStageHistory(contact: {
    id: string;
    stageHistory?: Array<{
      fromStage: string | null;
      toStage: string;
      changedAt: Date;
      changedById: string;
      direction?: string;
      reason?: string;
    }>;
  }): TimelineEntry[] {
    return (contact.stageHistory ?? [])
      .slice(-SOURCE_LIMIT)
      .map((entry, index) => ({
        id: `stage:${contact.id}:${index}`,
        source: 'stage_change' as const,
        type: 'stage_change',
        occurredAt: entry.changedAt,
        actorId: entry.changedById ? String(entry.changedById) : null,
        title: entry.fromStage
          ? `${entry.fromStage} → ${entry.toStage}`
          : `Entered ${entry.toStage}`,
        meta: {
          fromStage: entry.fromStage,
          toStage: entry.toStage,
          direction: entry.direction,
          reason: entry.reason,
        },
      }));
  }

  /**
   * One source failing must degrade the feed, not empty it: a missing tickets
   * collection in a trimmed deployment should cost the ticket entries, not the
   * whole customer history.
   *
   * `source` selects the owner/org-unit/ABAC predicate to intersect — the same
   * one that module's repository applies. Without it this method was a read of
   * another module's records with the tenant filter and nothing else.
   */
  private async find(
    collection: string,
    source: TimelineSource,
    query: {
      filter: Record<string, unknown>;
      projection: Record<string, 1>;
      sort: Record<string, 1 | -1>;
    },
  ): Promise<any[]> {
    try {
      return await this.connection
        .collection(collection)
        .find(this.scoped(source, query.filter), {
          projection: query.projection,
        })
        .sort(query.sort)
        .limit(SOURCE_LIMIT)
        .toArray();
    } catch (err) {
      this.logger.warn(
        `Timeline source ${collection} unavailable: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Bind the tenant and intersect the module's data-visibility scope.
   *
   * `tenantId` is applied HERE rather than in each per-source filter: the raw
   * driver bypasses the tenant Mongoose plugin, so leaving it to seven callers
   * means one of them eventually forgets and reads every tenant's rows.
   */
  private scoped(
    source: TimelineSource,
    filter: Record<string, unknown>,
  ): Record<string, unknown> {
    const scoped: Record<string, unknown> = {
      ...filter,
      tenantId: toId(this.tenantId()),
    };

    // No scope module means the rows are governed by the contact whose ACL the
    // caller already passed. Applying the owner axis to them would hide notes
    // and activity_logs from every scoped user — those collections carry no
    // `ownerId`, so `{ownerId: {$in: [...]}}` matches nothing at all.
    const scopeModule = SOURCE_AUTHZ[source].scopeModule;
    if (!scopeModule) return scoped;

    const clauses = buildVisibilityClauses(this.cls, scopeModule);
    if (!clauses) return scoped;
    return { ...scoped, $and: [...((scoped.$and as any[]) ?? []), ...clauses] };
  }

  /**
   * The caller's effective permission keys.
   *
   * Read from the same cache `PermissionGuard` uses, so the feed and the
   * per-module endpoints answer from one source. An unresolvable caller yields
   * an empty set — fail closed: the contact-level sources stay, the cross-module
   * ones drop out.
   */
  private async grantedPermissions(): Promise<ReadonlySet<string>> {
    const userId = this.cls.get<string>('userId');
    const tenantId = this.tenantId();
    if (!userId || !tenantId) return new Set();

    // `effective` already equals the tenant ceiling when fullAccess is true, so
    // an admin needs no special case here.
    const explanation = await this.authzCache.explainForUser(userId, tenantId);
    return new Set(explanation.effective);
  }

  private tenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }
}

function empty(): Promise<TimelineEntry[]> {
  return Promise.resolve([]);
}

function toId(value: string): any {
  return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : value;
}

function beforeDate(field: string, before?: Date): Record<string, unknown> {
  return before && !Number.isNaN(before.getTime())
    ? { [field]: { $lt: before } }
    : {};
}

function excerpt(content: unknown, length = 140): string {
  if (typeof content !== 'string') return '';
  // Notes are rich text; tags in a timeline summary are noise.
  const text = content
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}
