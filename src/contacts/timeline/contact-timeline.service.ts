import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { ContactRepository } from '../infrastructure/persistence/document/repositories/contact.repository';

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
 * This is deliberately a QUERY-TIME fan-in rather than the `contact_timeline`
 * collection the audit recommends. The collection is the right end state: it is
 * append-only, indexable on `(tenantId, contactId, occurredAt)`, and partitionable
 * by month, which is what makes the feed viable at 100M contacts. But it needs a
 * listener per source plus a backfill of existing history, and until that lands
 * this service delivers the same API and the same user-visible result from the
 * data already there. The endpoint contract does not change when the collection
 * arrives — only what this method reads from.
 *
 * The per-source caps are the honest limitation: this returns the most recent
 * `SOURCE_LIMIT` of each source, merged and trimmed, not a true global cursor.
 * A contact with 200 notes and 3 tickets will show all 3 tickets and the newest
 * 50 notes. `truncatedSources` reports exactly which sources were capped rather
 * than presenting a partial feed as complete.
 */
@Injectable()
export class ContactTimelineService {
  private readonly logger = new Logger(ContactTimelineService.name);

  constructor(
    private readonly contacts: ContactRepository,
    private readonly cls: ClsService,
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
    nextCursor?: string;
    hasNextPage: boolean;
  }> {
    // Read the contact through the repository first: that applies the tenant and
    // visibility axes, so the timeline cannot become a side door to a record the
    // caller may not see.
    const contact = await this.contacts.findOne({ _id: contactId });
    if (!contact) throw new NotFoundException('Contact not found');

    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const wanted = new Set<TimelineSource>(
      options.sources && options.sources.length > 0
        ? options.sources
        : [
            'activity',
            'note',
            'ticket',
            'deal',
            'task',
            'conversation',
            'stage_change',
          ],
    );

    const tenantId = this.tenantId();
    const oid = new Types.ObjectId(contactId);

    const results = await Promise.all([
      wanted.has('activity')
        ? this.fetchActivities(tenantId, contactId, options.before)
        : empty(),
      wanted.has('note')
        ? this.fetchNotes(tenantId, oid, options.before)
        : empty(),
      wanted.has('ticket')
        ? this.fetchTickets(tenantId, oid, options.before)
        : empty(),
      wanted.has('deal')
        ? this.fetchDeals(tenantId, oid, options.before)
        : empty(),
      wanted.has('task')
        ? this.fetchTasks(tenantId, contactId, options.before)
        : empty(),
      wanted.has('conversation')
        ? this.fetchConversations(tenantId, oid, options.before)
        : empty(),
      wanted.has('stage_change')
        ? this.fetchStageTransitions(tenantId, oid, options.before)
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
      hasNextPage,
      nextCursor:
        hasNextPage && data.length > 0
          ? new Date(data[data.length - 1].occurredAt).toISOString()
          : undefined,
    };
  }

  // ── Per-source fetchers ────────────────────────────────────────────────
  //
  // Raw-connection reads by collection name, like the merge registry: pulling
  // Tickets/Deals/OmniInbound services in here would recreate the dependency
  // cycles ContactsModule already avoids. Each is projected down to the few
  // fields the feed renders — a timeline must never drag whole documents across.

  private async fetchActivities(
    tenantId: string,
    contactId: string,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('activity_logs', {
      filter: {
        tenantId: toId(tenantId),
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
    tenantId: string,
    contactId: Types.ObjectId,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('notes', {
      filter: {
        tenantId: toId(tenantId),
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
    tenantId: string,
    contactId: Types.ObjectId,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('tickets', {
      filter: {
        tenantId: toId(tenantId),
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
    tenantId: string,
    contactId: Types.ObjectId,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('deals', {
      filter: {
        tenantId: toId(tenantId),
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
    tenantId: string,
    contactId: string,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('tasks', {
      filter: {
        tenantId: toId(tenantId),
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
    tenantId: string,
    contactId: Types.ObjectId,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('omni_conversations', {
      filter: {
        tenantId: toId(tenantId),
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
    tenantId: string,
    contactId: Types.ObjectId,
    before?: Date,
  ): Promise<TimelineEntry[]> {
    const rows = await this.find('contact_stage_transitions', {
      filter: {
        tenantId: toId(tenantId),
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
   */
  private async find(
    collection: string,
    query: {
      filter: Record<string, unknown>;
      projection: Record<string, 1>;
      sort: Record<string, 1 | -1>;
    },
  ): Promise<any[]> {
    try {
      return await this.connection
        .collection(collection)
        .find(query.filter, { projection: query.projection })
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
