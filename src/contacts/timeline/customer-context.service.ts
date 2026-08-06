import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { ContactRepository } from '../infrastructure/persistence/document/repositories/contact.repository';
import { AuthzPermissionCacheService } from '../../common/permissions/authz-permission-cache.service';
import { buildVisibilityClauses } from '../../common/permissions/visibility-scope';

/** A deal, trimmed to what a support agent needs to see mid-conversation. */
export interface CustomerContextDeal {
  id: string;
  name: string;
  amount: number | null;
  currency: string | null;
  stageId: string | null;
  isOpen: boolean;
  updatedAt: Date | null;
}

/** A ticket, likewise. */
export interface CustomerContextTicket {
  id: string;
  subject: string;
  statusId: string | null;
  priority: string | null;
  isOpen: boolean;
  createdAt: Date | null;
}

/** One channel this customer has ever used, and when they last did. */
export interface CustomerContextChannel {
  channelType: string;
  conversationCount: number;
  lastMessageAt: Date | null;
}

export interface CustomerContext {
  /** Money in flight and money already taken. */
  value: {
    totalRevenue: number;
    openDealsValue: number;
    dealsCount: number;
    wonDealsCount: number;
    firstPurchaseAt: Date | null;
    lastPurchaseAt: Date | null;
  };
  deals: CustomerContextDeal[];
  tickets: CustomerContextTicket[];
  openTicketCount: number;
  csat: {
    lastScore: number | null;
    avgScore: number | null;
    responseCount: number;
  };
  /** Every channel this person has reached us on — the omni view of one customer. */
  channels: CustomerContextChannel[];
  /** Sources the caller may not read, so the UI can say so rather than show zero. */
  deniedSources: string[];
}

/** Per-list cap. This is a context panel, not a report. */
const LIST_LIMIT = 5;

/**
 * CustomerContextService — what an agent needs to know about the person they are
 * replying to, in one request.
 *
 * The omni inbox panel already asked for this: it issued queries to `/deals` and
 * `/tickets` on every conversation open and **discarded both results** — the
 * `useQuery` calls were never destructured and nothing rendered them. So the
 * network cost was paid on every conversation and the agent still answered
 * customers with no idea whether there was a deal in flight or three open
 * complaints. Sales context and service context, the two things a CRM inbox has
 * that a chat tool does not, were absent.
 *
 * One endpoint rather than three round trips, because this is on the path an agent
 * takes dozens of times an hour and each conversation switch should feel instant.
 *
 * Authorization mirrors ContactTimelineService: cross-module collections are read
 * on the raw connection, which bypasses both `@RequirePermission` and the
 * repositories' scope filters, so each source's own permission and visibility
 * clauses are applied here. Consolidating panels must not consolidate away their
 * authorization.
 */
@Injectable()
export class CustomerContextService {
  private readonly logger = new Logger(CustomerContextService.name);

  constructor(
    private readonly contacts: ContactRepository,
    private readonly cls: ClsService,
    private readonly authzCache: AuthzPermissionCacheService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async getContext(contactId: string): Promise<CustomerContext> {
    // Through the repository first: that applies the tenant and visibility axes,
    // so this cannot become a side door to a contact the caller may not see.
    const contact = await this.contacts.findOne({ _id: contactId });
    if (!contact) throw new NotFoundException('Contact not found');

    const granted = await this.grantedPermissions();
    const mayReadDeals = granted.has('deals:view');
    const mayReadTickets = granted.has('tickets:view');
    const mayReadConversations = granted.has('omni_channel:view');

    const oid = new Types.ObjectId(contactId);
    const [deals, tickets, csat, channels] = await Promise.all([
      mayReadDeals ? this.fetchDeals(oid) : Promise.resolve([]),
      mayReadTickets ? this.fetchTickets(oid) : Promise.resolve([]),
      mayReadConversations
        ? this.fetchCsat(oid)
        : Promise.resolve({
            lastScore: null,
            avgScore: null,
            responseCount: null,
          }),
      mayReadConversations ? this.fetchChannels(oid) : Promise.resolve([]),
    ]);

    const deniedSources = [
      ...(mayReadDeals ? [] : ['deals']),
      ...(mayReadTickets ? [] : ['tickets']),
      ...(mayReadConversations ? [] : ['conversations']),
    ];

    return {
      value: {
        // Denormalised on the contact by the deal write path, so the headline
        // figures cost nothing here.
        totalRevenue: (contact as any).totalRevenue ?? 0,
        openDealsValue: deals
          .filter((deal) => deal.isOpen)
          .reduce((sum, deal) => sum + (deal.amount ?? 0), 0),
        dealsCount: (contact as any).dealsCount ?? 0,
        wonDealsCount: (contact as any).wonDealsCount ?? 0,
        firstPurchaseAt: (contact as any).firstPurchaseAt ?? null,
        lastPurchaseAt: (contact as any).lastPurchaseAt ?? null,
      },
      deals,
      tickets,
      openTicketCount: tickets.filter((ticket) => ticket.isOpen).length,
      csat: {
        lastScore: csat.lastScore,
        avgScore: csat.avgScore,
        responseCount: csat.responseCount ?? 0,
      },
      channels,
      deniedSources,
    };
  }

  private async fetchDeals(
    contactId: Types.ObjectId,
  ): Promise<CustomerContextDeal[]> {
    const rows = await this.find('deals', 'Deal', {
      filter: { contactIds: contactId, deletedAt: null },
      projection: {
        name: 1,
        title: 1,
        amount: 1,
        value: 1,
        currency: 1,
        stageId: 1,
        wonAt: 1,
        lostAt: 1,
        updatedAt: 1,
      },
      // Open deals first, then most recently touched: the one an agent needs is
      // the live one, not the biggest closed one.
      sort: { wonAt: 1, updatedAt: -1 },
    });

    return rows.map((row) => ({
      id: String(row._id),
      name: String(row.name ?? row.title ?? 'Deal'),
      amount: numberOrNull(row.amount ?? row.value),
      currency: row.currency ? String(row.currency) : null,
      stageId: row.stageId ? String(row.stageId) : null,
      isOpen: !row.wonAt && !row.lostAt,
      updatedAt: row.updatedAt ?? null,
    }));
  }

  private async fetchTickets(
    contactId: Types.ObjectId,
  ): Promise<CustomerContextTicket[]> {
    const rows = await this.find('tickets', 'Ticket', {
      filter: { contactId, deletedAt: null },
      projection: {
        subject: 1,
        title: 1,
        statusId: 1,
        priority: 1,
        resolvedAt: 1,
        closedAt: 1,
        createdAt: 1,
      },
      sort: { createdAt: -1 },
    });

    return rows.map((row) => ({
      id: String(row._id),
      subject: String(row.subject ?? row.title ?? 'Ticket'),
      statusId: row.statusId ? String(row.statusId) : null,
      priority: row.priority ? String(row.priority) : null,
      isOpen: !row.resolvedAt && !row.closedAt,
      createdAt: row.createdAt ?? null,
    }));
  }

  /**
   * Satisfaction across every conversation this person has had with us — the
   * question "is this customer already unhappy?", which an agent needs before
   * they start typing.
   */
  private async fetchCsat(contactId: Types.ObjectId): Promise<{
    lastScore: number | null;
    avgScore: number | null;
    responseCount: number | null;
  }> {
    const tenantId = toId(this.tenantId());
    try {
      const [row] = await this.connection
        .collection('omni_conversations')
        .aggregate([
          {
            $match: this.scoped('Conversation', tenantId, {
              contactId,
              csatScore: { $ne: null },
            }),
          },
          { $sort: { csatSubmittedAt: -1 } },
          {
            $group: {
              _id: null,
              lastScore: { $first: '$csatScore' },
              avgScore: { $avg: '$csatScore' },
              responseCount: { $sum: 1 },
            },
          },
        ])
        .toArray();

      return {
        lastScore: numberOrNull(row?.lastScore),
        avgScore: row?.avgScore == null ? null : round1(row.avgScore),
        responseCount: row?.responseCount ?? 0,
      };
    } catch (err) {
      this.logger.warn(
        `CSAT context unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { lastScore: null, avgScore: null, responseCount: null };
    }
  }

  /**
   * Which channels this customer uses.
   *
   * This is the omni answer the inbox was missing: an agent replying on WhatsApp
   * can see the same person also wrote on Facebook last week, and click through.
   */
  private async fetchChannels(
    contactId: Types.ObjectId,
  ): Promise<CustomerContextChannel[]> {
    const tenantId = toId(this.tenantId());
    try {
      const rows = await this.connection
        .collection('omni_conversations')
        .aggregate([
          { $match: this.scoped('Conversation', tenantId, { contactId }) },
          {
            $group: {
              _id: '$channelType',
              conversationCount: { $sum: 1 },
              lastMessageAt: { $max: '$lastMessageAt' },
            },
          },
          { $sort: { lastMessageAt: -1 } },
        ])
        .toArray();

      return rows.map((row) => ({
        channelType: String(row._id ?? 'unknown'),
        conversationCount: row.conversationCount,
        lastMessageAt: row.lastMessageAt ?? null,
      }));
    } catch (err) {
      this.logger.warn(
        `Channel context unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * One source failing degrades the panel rather than emptying it: a trimmed
   * deployment without a `deals` collection should cost the deal list, not the
   * whole context.
   */
  private async find(
    collection: string,
    scopeModule: string,
    query: {
      filter: Record<string, unknown>;
      projection: Record<string, 1>;
      sort: Record<string, 1 | -1>;
    },
  ): Promise<any[]> {
    const tenantId = toId(this.tenantId());
    try {
      return await this.connection
        .collection(collection)
        .find(this.scoped(scopeModule, tenantId, query.filter), {
          projection: query.projection,
        })
        .sort(query.sort)
        .limit(LIST_LIMIT)
        .toArray();
    } catch (err) {
      this.logger.warn(
        `Customer-context source ${collection} unavailable: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Bind the tenant and intersect the module's data-visibility scope.
   *
   * `tenantId` is spelled out at every call site rather than only inside this
   * helper. The raw driver bypasses the tenant Mongoose plugin, so the tenant
   * predicate is the one thing a reader must be able to see without following a
   * function — and `raw-mongo-tenant-boundary.spec.ts` enforces exactly that by
   * looking for the token next to each raw operation.
   */
  private scoped(
    scopeModule: string,
    tenantId: unknown,
    filter: Record<string, unknown>,
  ): Record<string, unknown> {
    const scoped: Record<string, unknown> = { ...filter, tenantId };
    const clauses = buildVisibilityClauses(this.cls, scopeModule);
    if (!clauses) return scoped;
    return { ...scoped, $and: clauses };
  }

  /** The caller's effective permission keys, from the guard's own cache. */
  private async grantedPermissions(): Promise<ReadonlySet<string>> {
    const userId = this.cls.get<string>('userId');
    const tenantId = this.tenantId();
    if (!userId || !tenantId) return new Set();
    const explanation = await this.authzCache.explainForUser(userId, tenantId);
    return new Set(explanation.effective);
  }

  private tenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }
}

function toId(value: string): any {
  return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : value;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
