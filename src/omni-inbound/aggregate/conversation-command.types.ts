/**
 * Conversation Aggregate — Command Types
 *
 * Every mutation to a conversation flows through a typed Command that is
 * enqueued into the conversation-ops BullMQ queue and processed
 * sequentially per conversation by ConversationOpsProcessor.
 *
 * Phase 1 commands: CUSTOMER_MESSAGE, BOT_REPLY, AGENT_REPLY
 * Phase 2 (future): ASSIGN_AGENT, CHANGE_STATUS, ADD_TAG, RESOLVE, etc.
 */

import { OmniPayload } from '../domain/omni-payload';
import { BotReplyMessage } from '../bot/bot-processing.types';

// ────────────────────────────────────────────────────────────────────────────
// Command Envelope
// ────────────────────────────────────────────────────────────────────────────

export type ConversationCommandType =
  | 'CUSTOMER_MESSAGE'
  | 'BOT_REPLY'
  | 'AGENT_REPLY'
  | 'ASSIGN_AGENT'
  | 'CHANGE_STATUS'
  | 'UPDATE_BOT_STATE';

/**
 * Base command envelope. Every command carries:
 * - operationId: ULID, globally unique, used for idempotency
 * - sourceId:    dedup key from origin (externalMessageId, bot:inboundMsgId:idx)
 * - type:        discriminator for the processor switch
 */
export interface ConversationCommand {
  operationId: string;
  sourceId: string;
  type: ConversationCommandType;
  conversationId: string;
  tenantId: string;
  payload: Record<string, any>;
  createdAt: string; // ISO-8601
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 1 Commands
// ────────────────────────────────────────────────────────────────────────────

export interface CustomerMessageCommand extends ConversationCommand {
  type: 'CUSTOMER_MESSAGE';
  payload: CustomerMessagePayload;
}

export interface CustomerMessagePayload {
  /** Full normalized inbound message data */
  omniPayload: OmniPayload;
  /** Dedup key for the message (externalMessageId or synthetic hash) */
  messageDedupId: string;
  /** Redis idempotency key to expire after processing */
  idemKey: string;
}

export interface BotReplyCommand extends ConversationCommand {
  type: 'BOT_REPLY';
  payload: BotReplyPayload;
}

export interface BotReplyPayload {
  messages: BotReplyMessage[];
  handoff: boolean;
  handoffMeta?: {
    target: 'general' | 'group' | 'agent';
    groupId?: string;
    agentId?: string;
    message?: string;
  };
  sessionId?: string;
  status: 'active' | 'handoff' | 'ended';
  inboundMessageId: string;
  /** providerTimestamp from triggering customer message — bot replies sort after this */
  afterTimestamp?: number;
}

export interface AgentReplyCommand extends ConversationCommand {
  type: 'AGENT_REPLY';
  payload: AgentReplyPayload;
}

export interface AgentReplyPayload {
  agentId: string;
  content: string;
  messageType: string;
  messageId: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Bot Event (emitted by BotCallbackController, consumed by CommandService)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Decoupled event emitted by BotCallbackController.
 * ConversationCommandService listens and converts to BOT_REPLY command.
 *
 * This pattern allows future bot sources (AI Agent, Flow Builder,
 * External Automation) to emit the same event without changing the
 * aggregate architecture.
 */
export interface BotGeneratedReplyEvent {
  conversationId: string;
  tenantId: string;
  messages: BotReplyMessage[];
  handoff: boolean;
  handoffMeta?: {
    target: 'general' | 'group' | 'agent';
    groupId?: string;
    agentId?: string;
    message?: string;
  };
  sessionId?: string;
  status: 'active' | 'handoff' | 'ended';
  inboundMessageId: string;
  /** providerTimestamp from triggering customer message */
  afterTimestamp?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 2 Commands
// ────────────────────────────────────────────────────────────────────────────

export interface AssignAgentCommand extends ConversationCommand {
  type: 'ASSIGN_AGENT';
  payload: AssignAgentPayload;
}

export interface AssignAgentPayload {
  agentId?: string | null;
  groupId?: string | null;
  previousAgentId?: string | null;
  previousGroupId?: string | null;
  performedByUserId?: string | null;
  reason: string; // 'manual' | 'auto' | 'takeover' | 'bot_handoff' | 'fallback' | 'reply_auto_assign'
  /** If true, only assign when conversation is currently unassigned (CAS semantics) */
  onlyIfUnassigned?: boolean;
  /** Agent pool capacity sync — fire-and-forget after commit */
  syncCapacity?: { releaseAgentId?: string; assignAgentId?: string };
  /** Audit log data for routing history */
  auditLog?: { channelType?: string };
}

export interface ChangeStatusCommand extends ConversationCommand {
  type: 'CHANGE_STATUS';
  payload: ChangeStatusPayload;
}

export interface ChangeStatusPayload {
  newStatus: 'open' | 'pending' | 'resolved' | 'closed';
  oldStatus?: string;
  agentId?: string | null;
  reason?: string;
  note?: string;
  resolveSource?: string; // 'agent' | 'auto' | 'system'
  channelType?: string;
  channelAccount?: string;
  externalConversationId?: string;
}

export interface UpdateBotStateCommand extends ConversationCommand {
  type: 'UPDATE_BOT_STATE';
  payload: UpdateBotStatePayload;
}

export interface UpdateBotStatePayload {
  botState: Partial<{
    enabled: boolean;
    status: string;
    sessionId: string | null;
    lockedAt: Date | null;
    lastError: string;
    provider: string;
  }>;
  reason: string; // 'agent_takeover' | 'agent_reenable' | 'bot_dispatch_error' | 'auto_init'
  agentId?: string;
}

