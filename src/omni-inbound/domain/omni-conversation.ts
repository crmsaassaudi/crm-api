import { ChannelType } from './omni-payload';

export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type BotConversationStatus = 'active' | 'handoff' | 'ended';

/**
 * The three SLA metrics a conversation is measured on.
 *
 * `next_response` is per-turn: every customer message after the first opens a new
 * cycle, which is what distinguishes "answered once then ignored" from "answered
 * throughout" — the case a first-response-only model cannot see.
 */
export type SlaMetric = 'first_response' | 'next_response' | 'resolution';

/**
 * Channel-level bot mode — controls how bot and auto-assignment interact.
 *
 * - `bot_first`: Bot handles conversation first. Auto-assignment is DEFERRED
 *                until bot emits `handoff_to_agent`. Recommended mode.
 * - `bot_only`:  Bot handles everything. No handoff to human agent.
 * - `disabled`:  No bot — auto-assign agent immediately (legacy behavior).
 */
export type BotMode = 'bot_first' | 'bot_only' | 'disabled';

// Removed: `lockedAt`, the visible half of an abandoned "lock the conversation while
// the bot is thinking" design. Four code paths dutifully cleared it and NOTHING ever
// set it, which is worse than absence: a reader seeing `$unset: {'bot.lockedAt': 1}`
// on handoff reasonably concludes some path takes that lock. Its service half
// (`bot/bot-conversation-lock.service.ts`) was orphaned in the same way — never
// provided, never injected.
//
// Conversation mutations ARE serialized, by `ConversationOpsProcessor`, which wraps
// every command in `RedisLockService.acquire('conv-ops-lock:<id>')` — and bot state
// writes reach it through `enqueueUpdateBotState`. Wiring the bot lock back in would
// have been actively harmful: a second lock namespace over the same resource
// protects nothing, and it had no heartbeat, so it could expire mid-operation with
// no abort signal (the thing `RedisLockService` exists to provide).
export interface ConversationBotState {
  enabled: boolean;
  provider: string;
  flowId?: string | null;
  sessionId?: string | null;
  status: BotConversationStatus;
  lastError?: string | null;
  handoffReason?: string | null;
  handoffMessage?: string | null;
  handoffTarget?: 'general' | 'group' | 'agent' | null;
  handoffTargetId?: string | null;
  handedOffAt?: Date | null;
  handedOffByInboundMessageId?: string | null;
}

/**
 * Normalized conversation entity — aggregates messages from a single
 * customer thread regardless of channel.
 */
export interface OmniConversation {
  id: string;
  tenantId: string;

  /** The channel this conversation belongs to */
  channelId: string;
  inboxId: string | null;
  channelType: ChannelType;
  channelAccount: string;

  /** External thread / conversation ID from the provider */
  externalConversationId: string;

  /** Reference to the overarching Contact entity in CRM */
  contactId: string | null;

  /** Customer information (resolved from provider or linked contact) */
  customer: {
    externalId: string;
    name: string;
    avatarUrl?: string;
    email?: string;
    phone?: string;
  };

  /** Which agent currently owns this conversation (null = unassigned / in queue) */
  assignedAgentId: string | null;

  /** Which group/team is responsible for this conversation */
  assignedGroupId: string | null;

  /** For collision detection: which agent last "claimed" this conversation */
  claimedBy: string | null;
  claimedAt: Date | null;

  status: ConversationStatus;

  /** Chatbot runtime state for async bot handoff/reply processing. */
  bot?: ConversationBotState | null;

  /** Snippet of the last message for the chat list */
  lastMessage: string;
  lastMessageAt: Date | null;

  unreadCount: number;

  /** CRM entity linkage */
  linkedLeadId?: string;

  tags: string[];

  // Reopen tracking
  reopenCount: number;
  previousConversationId: string | null;

  // Close / Resolve metadata
  resolvedByAgentId: string | null;
  resolvedAt: Date | null;
  resolveReason: string | null;
  resolveNote: string | null;
  resolveSource: 'agent' | 'auto' | 'bot' | 'system' | null;

  assignedAgent?: any;
  resolvedByAgent?: any;

  // Platform Reply Window
  lastCustomerMessageAt: Date | null;

  // Handling timeline — the facts FRT, time-to-assign and wait time derive from.
  firstRespondedAt: Date | null;
  firstResponderId: string | null;
  queuedAt: Date | null;
  assignedAt: Date | null;
  totalQueuedMs: number;

  // SLA read model, projected from `omni_sla_clocks`.
  slaDueAt: Date | null;
  slaDueMetric: SlaMetric | null;
  slaBreached: boolean;
  slaBreachedAt: Date | null;

  escalationLevel: 'warning' | 'critical' | null;

  // Snooze
  snoozeUntil: Date | null;

  createdAt: Date;
  updatedAt: Date;
}
