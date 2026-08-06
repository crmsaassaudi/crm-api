import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LRUCache } from 'lru-cache';
import type { Server, Socket } from 'socket.io';
import { ConversationRepository } from '../repositories/conversation.repository';
import { OmniEvents } from '../domain/omni-events';

/**
 * The authorization facts a socket carries, resolved once at connect time from
 * the same `DataVisibilityInterceptor.resolveVisibility()` the REST layer uses.
 *
 * `null` means "unrestricted on this axis" — the same convention as the CLS
 * values these are copied from, where `null` and `[]` are opposites.
 */
export interface SocketScope {
  /** Channels this agent may serve. `null` = every channel in the tenant. */
  channelIds: string[] | null;
  /** Record owners this agent may see. `null` = all owners. */
  ownerIds: string[] | null;
  /** Whether unassigned conversations are inside this agent's scope. */
  includeUnowned: boolean;
  /** Whether this agent may see the customer's phone and email. */
  canUnmask: boolean;
  /**
   * The principal's effective permission keys.
   *
   * Carried on the socket because socket handlers get none of the HTTP pipeline —
   * no guard runs — so each command has to check for itself, and re-resolving
   * permissions per message would put a Redis round trip on the send path.
   */
  permissions: ReadonlySet<string>;
}

/** Authorization-relevant facts about a conversation. */
interface ConversationFacts {
  channelId: string | null;
  assignedAgentId: string | null;
}

/**
 * Bounded so a long-lived process cannot grow without limit — this cache is
 * keyed by conversation id, and a busy tenant opens conversations forever.
 * 10k entries at ~100 bytes is ~1 MB; TTL keeps a reassignment we somehow
 * missed from being wrong for longer than a few seconds.
 */
const FACTS_CACHE_MAX = 10_000;
const FACTS_CACHE_TTL_MS = 30_000;

/**
 * ConversationAudienceService — decides which connected agents may receive a
 * conversation's realtime events, and what they may see of it.
 *
 * Why this exists: every omni broadcast used to go to `tenant:{tenantId}`, so
 * every authenticated agent received every message body, customer name, phone
 * and email in the tenant. That bypassed all three controls the REST layer
 * applies — the channel support pool (`servableChannelIds`), the owner/org-unit
 * visibility scope, and `omni_channel:unmask` field masking, which cannot apply
 * to a socket at all because `FieldMaskingInterceptor` is an HTTP interceptor.
 * An agent restricted to one channel's inbox could read every other channel's
 * conversations by listening.
 *
 * Why filtering per socket rather than per room: the two axes are ANDed, and
 * rooms can only express OR. Composing them into room names
 * (`channel × owner`) needs |channels| × |owners| joins per socket. Masking
 * makes it worse — the same event has two shapes depending on the recipient's
 * permission.
 *
 * Filtering is cheap and node-local. Each API node already receives every
 * cross-process event over Redis pub/sub and re-broadcasts to its own sockets,
 * so iterating `server.sockets.sockets` (local only) and testing a handful of
 * in-memory fields costs no I/O and no cross-node round trip. Every node runs
 * the same predicate over its own connections, so the result is complete.
 */
@Injectable()
export class ConversationAudienceService {
  private readonly logger = new Logger(ConversationAudienceService.name);

  private readonly facts = new LRUCache<string, ConversationFacts>({
    max: FACTS_CACHE_MAX,
    ttl: FACTS_CACHE_TTL_MS,
  });

  constructor(private readonly conversations: ConversationRepository) {}

  /**
   * Deliver an event to exactly those local sockets in the tenant that are
   * allowed to see this conversation.
   *
   * @param facts Authorization facts already known to the caller. Supplying them
   *   avoids a database read on the inbound hot path, where the message event
   *   already carries the channel id.
   */
  async emitToConversation(
    server: Server | undefined,
    target: {
      tenantId: string;
      conversationId: string;
      facts?: Partial<ConversationFacts>;
    },
    event: string,
    payload: unknown,
  ): Promise<void> {
    if (!server) return;

    const sockets = this.localTenantSockets(server, target.tenantId);
    if (sockets.length === 0) return;

    const resolved = await this.resolveFacts(
      target.tenantId,
      target.conversationId,
      target.facts,
    );

    for (const socket of sockets) {
      const scope = socket.data.scope as SocketScope | undefined;
      if (!this.maySee(scope, resolved)) continue;
      socket.emit(event, scope?.canUnmask ? payload : redactPii(payload));
    }
  }

  /**
   * Deliver to every local socket in the tenant, with PII redacted per socket.
   *
   * For tenant-level events that are not about one customer — presence, agent
   * status, queue counters. Conversation events must use `emitToConversation`.
   */
  emitToTenant(
    server: Server | undefined,
    tenantId: string,
    event: string,
    payload: unknown,
  ): void {
    if (!server) return;
    for (const socket of this.localTenantSockets(server, tenantId)) {
      const scope = socket.data.scope as SocketScope | undefined;
      socket.emit(event, scope?.canUnmask ? payload : redactPii(payload));
    }
  }

  /**
   * Whether a principal with this scope may see this conversation.
   *
   * The read-side counterpart of the broadcast filter, for socket commands that
   * name a conversation (`conversation.subscribe`, lock, claim, typing) — the
   * same predicate, so a client cannot reach by request what it would not be sent.
   */
  async mayAccess(
    scope: SocketScope | undefined,
    tenantId: string | undefined,
    conversationId: string,
  ): Promise<boolean> {
    if (!scope || !tenantId) return false;
    return this.maySee(
      scope,
      await this.resolveFacts(tenantId, conversationId),
    );
  }

  /** Drop cached facts when the thing they describe changes. */
  @OnEvent(OmniEvents.CONVERSATION_ASSIGNED)
  onAssignmentChanged(event: { conversationId?: string }): void {
    if (event.conversationId) this.facts.delete(event.conversationId);
  }

  private localTenantSockets(server: Server, tenantId: string): Socket[] {
    const sockets: Socket[] = [];
    // `server.sockets.sockets` is this node's connections only, which is exactly
    // the set this node is responsible for delivering to.
    for (const socket of server.sockets.sockets.values()) {
      if (socket.data.tenantId === tenantId) sockets.push(socket);
    }
    return sockets;
  }

  /**
   * Both axes, ANDed — the same shape `ConversationRepository` applies to a list
   * query, so the socket feed and the REST feed answer the same question.
   *
   * A socket with no resolved scope receives nothing. That is the fail-closed
   * direction: an unresolved scope means we do not know what this agent may see.
   */
  private maySee(
    scope: SocketScope | undefined,
    facts: ConversationFacts,
  ): boolean {
    if (!scope) return false;

    if (
      scope.channelIds !== null &&
      (!facts.channelId || !scope.channelIds.includes(facts.channelId))
    ) {
      return false;
    }

    if (scope.ownerIds === null) return true;
    if (!facts.assignedAgentId) return scope.includeUnowned;
    return scope.ownerIds.includes(facts.assignedAgentId);
  }

  /**
   * The conversation's channel and owner, from cache or the database.
   *
   * `supplied` wins where present — the inbound message event already names the
   * channel, so that half never costs a read. The owner still has to be resolved,
   * which is what the cache is for: one read per conversation per TTL rather than
   * one per message.
   */
  private async resolveFacts(
    tenantId: string,
    conversationId: string,
    supplied?: Partial<ConversationFacts>,
  ): Promise<ConversationFacts> {
    let known = this.facts.get(conversationId);

    if (!known) {
      // Reads the conversation's real channel and owner rather than the reader's
      // filtered view of them: this decides who is *allowed* to receive an event.
      // A conversation we cannot describe gets `null` on both axes, which the
      // predicate treats as "only unrestricted agents may see it".
      known = (await this.conversations
        .findAuthorizationFacts(tenantId, conversationId)
        .catch((err: Error) => {
          this.logger.warn(
            `Audience facts unavailable for ${conversationId}: ${err.message}`,
          );
          return null;
        })) ?? { channelId: null, assignedAgentId: null };
      this.facts.set(conversationId, known);
    }

    return {
      channelId: supplied?.channelId ?? known.channelId,
      assignedAgentId: supplied?.assignedAgentId ?? known.assignedAgentId,
    };
  }
}

/** Field paths a socket payload must not carry to an agent without `unmask`. */
const PII_PATHS = ['customer.phone', 'customer.email'] as const;

/**
 * Redact the customer's contact details from a socket payload.
 *
 * The same two fields `FieldMaskingInterceptor` redacts on the REST response —
 * the point of the control is to protect the *data*, so it cannot depend on
 * which transport the data left by. Structural clone of only the touched
 * branch: the payload is shared across every recipient and must not be mutated.
 */
export function redactPii<T>(payload: T): T {
  if (!payload || typeof payload !== 'object') return payload;

  let clone: any = payload;
  for (const path of PII_PATHS) {
    const [parent, field] = path.split('.');
    const branch = (payload as any)[parent];
    if (!branch || typeof branch !== 'object' || branch[field] === undefined) {
      continue;
    }
    if (clone === payload) clone = { ...(payload as any) };
    clone[parent] = { ...clone[parent], [field]: null };
  }
  return clone;
}
