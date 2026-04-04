import { ChannelType } from './omni-payload';

export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'closed';

/**
 * Normalized conversation entity — aggregates messages from a single
 * customer thread regardless of channel.
 */
export interface OmniConversation {
  id: string;
  tenantId: string;

  /** The channel this conversation belongs to */
  channelId: string;
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

  /** For collision detection: which agent last "claimed" this conversation */
  claimedBy: string | null;
  claimedAt: Date | null;

  status: ConversationStatus;

  /** Snippet of the last message for the chat list */
  lastMessage: string;
  lastMessageAt: Date | null;

  unreadCount: number;

  /** CRM entity linkage */
  linkedLeadId?: string;

  tags: string[];

  // ── Reopen tracking ────────────────────────────────────────────
  reopenCount: number;
  previousConversationId: string | null;

  // ── Close / Resolve metadata ───────────────────────────────────
  resolvedByAgentId: string | null;
  resolvedAt: Date | null;
  resolveReason: string | null;
  resolveNote: string | null;
  resolveSource: 'agent' | 'auto' | 'bot' | 'system' | null;

  assignedAgent?: any;
  resolvedByAgent?: any;

  // ── Platform Reply Window ──────────────────────────────────────
  lastCustomerMessageAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}
