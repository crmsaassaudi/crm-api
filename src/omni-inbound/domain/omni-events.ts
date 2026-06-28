/**
 * OmniEvents — Typed event name constants and payload interfaces.
 *
 * Replaces magic string event names with compile-time safe constants.
 * Every event emitted or listened to in the omni-channel pipeline
 * should reference these constants instead of raw strings.
 *
 * Usage:
 *   // Emitter:
 *   this.eventEmitter.emit(OmniEvents.MESSAGE_PERSISTED, payload satisfies MessagePersistedEvent);
 *
 *   // Listener:
 *   @OnEvent(OmniEvents.MESSAGE_PERSISTED)
 *   handleMessagePersisted(event: MessagePersistedEvent) { ... }
 *
 * @module omni-inbound/domain
 */

// ────────────────────────────────────────────────────────────────────────────
// Event Name Constants
// ────────────────────────────────────────────────────────────────────────────

export const OmniEvents = {
  // ── Inbound Pipeline ─────────────────────────────────────────────────────
  /** Raw webhook received from any channel adapter (livechat bridge, etc.) */
  INBOUND_WEBHOOK: 'omni.inbound.webhook',
  /** Normalized message received, ready for processing */
  MESSAGE_RECEIVED: 'omni.message.received',
  /** Message persisted to DB with internal IDs */
  MESSAGE_PERSISTED: 'omni.message.persisted',
  /** Outbound message sent to customer */
  MESSAGE_SENT: 'omni.message.sent',
  /** Media proxy URL cached (replaces expiring provider URL) */
  MESSAGE_MEDIA_CACHED: 'omni.message.media_cached',
  /** Media caching failed */
  MESSAGE_MEDIA_CACHE_FAILED: 'omni.message.media_cache_failed',

  // ── Conversation Lifecycle ───────────────────────────────────────────────
  /** New conversation created */
  CONVERSATION_CREATED: 'omni.conversation.created',
  /** Existing conversation reopened (within reopen window) */
  CONVERSATION_REOPENED: 'omni.conversation.reopened',
  /** Conversation status changed (open/pending/resolved/closed) */
  CONVERSATION_STATUS_CHANGED: 'omni.conversation.status_changed',
  /** Agent assigned to conversation */
  CONVERSATION_ASSIGNED: 'omni.conversation.assigned',
  /** Customer profile updated on conversation */
  CONVERSATION_CUSTOMER_UPDATED: 'omni.conversation.customer_updated',
  /** Tag added to conversation */
  CONVERSATION_TAG_ADDED: 'omni.conversation.tag_added',
  /** Tag removed from conversation */
  CONVERSATION_TAG_REMOVED: 'omni.conversation.tag_removed',
  /** Internal note added */
  CONVERSATION_NOTE_ADDED: 'omni.conversation.note_added',
  /** Unread counter reset by agent */
  CONVERSATION_UNREAD_RESET: 'omni.conversation.unread_reset',
  /** Conversation escalated (SLA/policy) */
  CONVERSATION_ESCALATED: 'omni.conversation.escalated',
  /** SLA breached on conversation */
  CONVERSATION_SLA_BREACHED: 'omni.conversation.sla_breached',
  /** Ticket created from conversation */
  CONVERSATION_TICKET_CREATED: 'omni.conversation.ticket_created',
  /** Deal created from conversation */
  CONVERSATION_DEAL_CREATED: 'omni.conversation.deal_created',
  /** Agent took over conversation from another agent */
  CONVERSATION_TAKEOVER: 'omni.conversation.takeover',
  /** No agent available — conversation entered the wait queue */
  CONVERSATION_QUEUED: 'omni.conversation.queued',
  /** Agent replied to an unassigned conversation — trigger implicit assignment */
  REPLY_AUTO_ASSIGN: 'omni.conversation.reply_auto_assign',

  // ── Conversation Lock ────────────────────────────────────────────────────
  /** Agent acquired editing lock */
  CONVERSATION_LOCK_ACQUIRED: 'omni.conversation.lock_acquired',
  /** Agent released editing lock */
  CONVERSATION_LOCK_RELEASED: 'omni.conversation.lock_released',

  // ── Auto-Resolve ─────────────────────────────────────────────────────────
  /** Auto-resolve warning sent to agent (conversation about to be resolved) */
  AUTO_RESOLVE_WARNING: 'omni.auto_resolve.warning',

  // ── Out-of-Office ────────────────────────────────────────────────────────
  /** OOO auto-reply sent */
  OOO_AUTO_REPLY: 'omni.ooo.auto_reply',

  // ── Contact / Identity ───────────────────────────────────────────────────
  /** Contacts auto-merged during identity resolution */
  CONTACT_AUTO_MERGED: 'omni.contact.auto_merged',

  // ── Reactions ────────────────────────────────────────────────────────────
  /** Inbound reaction received from any channel */
  REACTION_INBOUND: 'omni.reaction.inbound',
  /** Reaction persisted to DB */
  REACTION_PERSISTED: 'omni.reaction.persisted',

  // ── Real-time / Typing ───────────────────────────────────────────────────
  /** Visitor typing indicator (livechat → CRM) */
  VISITOR_TYPING_LIVECHAT: 'omni.visitor.typing.livechat',
  /** Agent typing indicator (CRM → livechat visitor) */
  AGENT_TYPING_LIVECHAT: 'omni.agent.typing.livechat',

  // ── CSAT ─────────────────────────────────────────────────────────────────
  /** CSAT token generated for a resolved conversation */
  CSAT_TOKEN_GENERATED: 'omni.csat.token_generated',

  // ── Escalation ───────────────────────────────────────────────────────────
  /** Escalation notification sent */
  ESCALATION_NOTIFY: 'omni.escalation.notify',
  /** Escalation reassignment triggered */
  ESCALATION_REASSIGN: 'omni.escalation.reassign',

  // ── Activity ─────────────────────────────────────────────────────────────
  /** Activity trail entry created */
  ACTIVITY_CREATED: 'omni.activity.created',
} as const;

/** Union type of all Omni event name strings */
export type OmniEventName = (typeof OmniEvents)[keyof typeof OmniEvents];

// ────────────────────────────────────────────────────────────────────────────
// Livechat-specific events (bridge layer)
// ────────────────────────────────────────────────────────────────────────────

export const LivechatEvents = {
  /** Text message from visitor widget */
  MESSAGE_INBOUND: 'livechat.message.inbound',
  /** Media (file/image/video) from visitor widget */
  MEDIA_INBOUND: 'livechat.media.inbound',
  /** Message delivery/read status update for visitor */
  MESSAGE_STATUS: 'livechat.message.status',
  /** Agent marked messages as read */
  AGENT_READ: 'livechat.agent.read',
  /** Visitor file upload completed to S3 */
  VISITOR_UPLOAD_COMPLETED: 'livechat.visitor.upload_completed',
  /** Visitor file upload failed */
  VISITOR_UPLOAD_FAILED: 'livechat.visitor.upload_failed',
  /** Visitor identified via pre-chat form or CRMWidget.identify() */
  VISITOR_IDENTIFIED: 'livechat.visitor.identified',
} as const;

export type LivechatEventName =
  (typeof LivechatEvents)[keyof typeof LivechatEvents];

// ────────────────────────────────────────────────────────────────────────────
// CRM domain events (non-omni)
// ────────────────────────────────────────────────────────────────────────────

export const CrmEvents = {
  CONTACT_CREATED: 'contact.created',
  CONTACT_UPDATED: 'contact.updated',
  LEAD_CREATED: 'lead.created',
  LEAD_STATUS_UPDATED: 'lead.status.updated',
  TENANT_CREATED: 'tenant.created',
  CSAT_SUBMITTED: 'csat.submitted',
  EMAIL_READ_STATE_CHANGED: 'email.read_state.changed',
  DLQ_RECORDED: 'dlq.recorded',
} as const;

export type CrmEventName = (typeof CrmEvents)[keyof typeof CrmEvents];

// ────────────────────────────────────────────────────────────────────────────
// Event Payload Interfaces
// ────────────────────────────────────────────────────────────────────────────

/** Base shape shared by most omni events */
export interface OmniEventBase {
  tenantId: string;
  /**
   * T07: optional trace ID to correlate events across service boundaries.
   * Set once at the entry point (inbound webhook / socket message) and
   * propagated through all downstream events for the same logical operation.
   *
   * Format: UUID v4 or any unique string. When absent, use conversationId
   * as the fallback correlation key.
   */
  correlationId?: string;
}

/** omni.inbound.webhook */
export interface InboundWebhookEvent {
  channelType: string;
  channelId: string;
  tenantId: string;
  rawPayload: any;
}

/** omni.message.persisted */
export interface MessagePersistedEvent extends OmniEventBase {
  conversationId: string;
  messageId: string;
  internalMessageId: string;
  channelType: string;
  channelId: string;
  channelAccount: string;
  senderId: string;
  senderType: string;
  messageType: string;
  content: string;
  mediaUrl?: string;
  mediaProxyUrl?: string;
  metadata: Record<string, any>;
  externalMessageId: string;
  externalConversationId: string;
  timestamp: Date;
  providerTimestamp: Date;
}

/** omni.message.sent */
export interface MessageSentEvent extends OmniEventBase {
  conversationId: string;
  messageId: string;
  channelType: string;
  senderId: string;
  senderType: string;
  messageType: string;
  content: string;
  mediaUrl?: string;
  mediaProxyUrl?: string;
  metadata?: Record<string, any>;
  externalMessageId?: string;
  status?: string;
  createdAt?: Date;
}

/** omni.conversation.created */
export interface ConversationCreatedEvent extends OmniEventBase {
  conversationId: string;
  channelType: string;
  channelId: string;
  channelAccount: string;
  externalConversationId: string;
  contactId?: string | null;
}

/** omni.conversation.reopened */
export interface ConversationReopenedEvent extends OmniEventBase {
  conversationId: string;
  previousStatus?: string;
}

/** omni.conversation.status_changed */
export interface ConversationStatusChangedEvent extends OmniEventBase {
  conversationId: string;
  oldStatus: string;
  newStatus: string;
  changedBy?: string;
}

/** omni.conversation.assigned */
export interface ConversationAssignedEvent extends OmniEventBase {
  conversationId: string;
  agentId: string | null;
  previousAgentId?: string | null;
  assignedBy?: string;
  reason?: string;
  channelType?: string;
}

/** omni.conversation.customer_updated */
export interface ConversationCustomerUpdatedEvent extends OmniEventBase {
  conversationId: string;
  contactId: string;
}

/** omni.conversation.tag_added / tag_removed */
export interface ConversationTagEvent extends OmniEventBase {
  conversationId: string;
  tag: string;
  addedBy?: string;
}

/** omni.conversation.note_added */
export interface ConversationNoteAddedEvent extends OmniEventBase {
  conversationId: string;
  noteId: string;
  content: string;
  authorId: string;
  authorName?: string;
}

/** omni.conversation.unread_reset */
export interface ConversationUnreadResetEvent extends OmniEventBase {
  conversationId: string;
  agentId: string;
}

/** omni.conversation.lock_acquired / lock_released */
export interface ConversationLockEvent extends OmniEventBase {
  conversationId: string;
  agentId: string;
  agentName?: string;
}

/** omni.conversation.takeover */
export interface ConversationTakeoverEvent extends OmniEventBase {
  conversationId: string;
  newAgentId: string;
  previousAgentId: string;
}

/** omni.conversation.queued */
export interface ConversationQueuedEvent extends OmniEventBase {
  conversationId: string;
  /** The routing strategy that was attempted before queuing */
  strategy: string;
  /** Human-readable reason why no agent was available */
  reason: string;
  /** Channel that generated this conversation */
  channelType: string;
  /** Timestamp when queuing started (for SLA wait-time calculation) */
  queuedSince: Date;
  /** Size of the eligible agent pool that was evaluated */
  agentPoolSize: number;
}

/** omni.conversation.reply_auto_assign */
export interface ReplyAutoAssignEvent extends OmniEventBase {
  conversationId: string;
  agentId: string;
  /** Channel type for analytics */
  channelType: string;
}

/** omni.reaction.inbound */
export interface ReactionInboundEvent extends OmniEventBase {
  conversationId?: string;
  messageId?: string;
  senderId: string;
  emoji: string;
  action: 'set' | 'unset';
  channelType: string;
}

/** omni.reaction.persisted */
export interface ReactionPersistedEvent extends OmniEventBase {
  conversationId: string;
  messageId: string;
  reaction: {
    senderId: string;
    emoji: string;
    action: 'set' | 'unset';
  };
}

/** omni.visitor.typing.livechat / omni.agent.typing.livechat */
export interface TypingEvent extends OmniEventBase {
  conversationId?: string;
  visitorId?: string;
  agentId?: string;
  agentName?: string;
  isTyping: boolean;
  channelType?: string;
}

/** omni.csat.token_generated */
export interface CsatTokenGeneratedEvent extends OmniEventBase {
  conversationId: string;
  visitorId?: string;
  token: string;
  channelType: string;
}

/** omni.message.media_cached */
export interface MediaCachedEvent extends OmniEventBase {
  conversationId: string;
  messageId: string;
  mediaProxyUrl: string;
}

/** omni.contact.auto_merged */
export interface ContactAutoMergedEvent extends OmniEventBase {
  primaryContactId: string;
  mergedContactId: string;
  reason: string;
}

/** omni.escalation.notify */
export interface EscalationNotifyEvent extends OmniEventBase {
  conversationId: string;
  policyId: string;
  level: number;
  notifyUserIds: string[];
}

/** omni.escalation.reassign */
export interface EscalationReassignEvent extends OmniEventBase {
  conversationId: string;
  policyId: string;
  targetAgentId: string;
  previousAgentId?: string;
}

/** livechat.message.inbound */
export interface LivechatMessageInboundEvent {
  visitorId: string;
  tenantId: string;
  channelId: string;
  text: string;
  metadata?: Record<string, any>;
  timestamp?: number;
}

/** livechat.media.inbound */
export interface LivechatMediaInboundEvent {
  visitorId: string;
  tenantId: string;
  channelId: string;
  fileData: string; // base64
  fileName: string;
  mimeType: string;
  fileSize: number;
  timestamp?: number;
}

/** livechat.message.status */
export interface LivechatMessageStatusEvent {
  tenantId: string;
  conversationId: string;
  messageIds: string[];
  status: 'delivered' | 'read';
  visitorId?: string;
}

/** livechat.agent.read */
export interface LivechatAgentReadEvent {
  tenantId: string;
  conversationId: string;
  agentId: string;
  messageIds: string[];
}

/** livechat.visitor.upload_completed */
export interface LivechatVisitorUploadCompletedEvent {
  tenantId: string;
  visitorId: string;
  fileName: string;
  mimeType: string;
}

/** livechat.visitor.upload_failed */
export interface LivechatVisitorUploadFailedEvent {
  tenantId: string;
  visitorId: string;
  fileName: string;
  error: string;
}

/** livechat.visitor.identified — pre-chat form or CRMWidget.identify() */
export interface LivechatVisitorIdentifiedEvent {
  tenantId: string;
  visitorId: string;
  channelId: string;
  widgetId?: string;
  conversationId?: string;
  /** All form field values keyed by field.key */
  identityData: Record<string, any>;
}

