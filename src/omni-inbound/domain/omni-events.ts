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

// Event Name Constants

export const OmniEvents = {
  // Inbound Pipeline
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

  // Conversation Lifecycle
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
  CONVERSATION_TAG_ADDED: 'omni.conversation.tag_added',
  CONVERSATION_TAG_REMOVED: 'omni.conversation.tag_removed',
  /** Internal note added */
  CONVERSATION_NOTE_ADDED: 'omni.conversation.note_added',
  /** Unread counter reset by agent */
  CONVERSATION_UNREAD_RESET: 'omni.conversation.unread_reset',
  /** Conversation escalated (SLA/policy) */
  CONVERSATION_ESCALATED: 'omni.conversation.escalated',
  // A breach is `SlaEvents.BREACHED` — see sla-policies/clock/sla-events.ts.
  // The name moved when the clock engine started measuring tickets too, and
  // an omni-shaped name for a ticket breach would have been a lie.
  /** Agent took over conversation from another agent */
  CONVERSATION_TAKEOVER: 'omni.conversation.takeover',
  /** No agent available — conversation entered the wait queue */
  CONVERSATION_QUEUED: 'omni.conversation.queued',
  /** Agent replied to an unassigned conversation — trigger implicit assignment */
  REPLY_AUTO_ASSIGN: 'omni.conversation.reply_auto_assign',
  /** Capacity-reserved work was offered and awaits agent acceptance. */
  WORK_OFFER_CREATED: 'omni.work_offer.created',
  /** An offer lapsed or was declined and the item is back in the queue */
  WORK_ITEM_REQUEUED: 'omni.work_item.requeued',

  // Bot Lifecycle
  /** Bot handed off conversation to human agent — trigger auto-assignment */
  BOT_HANDOFF: 'omni.bot.handoff',
  /**
   * Bot session finished WITHOUT a handoff (flow ran to its end, or no flow is
   * bound to the channel). In `bot_first` mode auto-assignment was deferred at
   * conversation creation, so this event is what releases the conversation to a
   * human — otherwise it would sit with no bot and no agent.
   */
  BOT_ENDED: 'omni.bot.ended',
  /** Bot disabled on conversation (agent takeover or explicit toggle) */
  BOT_DISABLED: 'omni.bot.disabled',
  /** Bot re-enabled on conversation (agent undoes takeover) */
  BOT_ENABLED: 'omni.bot.enabled',

  // Conversation Lock
  /** Agent acquired editing lock */
  CONVERSATION_LOCK_ACQUIRED: 'omni.conversation.lock_acquired',
  /** Agent released editing lock */
  CONVERSATION_LOCK_RELEASED: 'omni.conversation.lock_released',

  // Auto-Resolve
  /** Auto-resolve warning sent to agent (conversation about to be resolved) */
  AUTO_RESOLVE_WARNING: 'omni.auto_resolve.warning',

  // Out-of-Office
  /** OOO auto-reply sent */
  OOO_AUTO_REPLY: 'omni.ooo.auto_reply',

  // Contact / Identity
  /** Contacts auto-merged during identity resolution */
  CONTACT_AUTO_MERGED: 'omni.contact.auto_merged',

  // Delivery receipts
  /** Provider reported delivered/read/failed for messages we sent */
  DELIVERY_RECEIPTS_RECEIVED: 'omni.delivery.receipts_received',

  // Reactions
  /** Inbound reaction received from any channel */
  REACTION_INBOUND: 'omni.reaction.inbound',
  REACTION_PERSISTED: 'omni.reaction.persisted',

  // Real-time / Typing
  /** Visitor typing indicator (livechat → CRM) */
  VISITOR_TYPING_LIVECHAT: 'omni.visitor.typing.livechat',
  /** Agent typing indicator (CRM → livechat visitor) */
  AGENT_TYPING_LIVECHAT: 'omni.agent.typing.livechat',

  // CSAT
  /** CSAT token generated for a resolved conversation */
  CSAT_TOKEN_GENERATED: 'omni.csat.token_generated',
  /**
   * A survey link needs sending to the customer on their own channel.
   *
   * Separate from TOKEN_GENERATED because the two have different audiences: the
   * token goes to the livechat widget, which renders the survey itself, while this
   * asks the outbound side to put a link in the conversation — the only way to
   * survey a customer on WhatsApp, Facebook or email.
   */
  CSAT_SURVEY_REQUESTED: 'omni.csat.survey_requested',

  // Activity
  /** Activity trail entry created */
  ACTIVITY_CREATED: 'omni.activity.created',
} as const;

/** Union type of all Omni event name strings */
export type OmniEventName = (typeof OmniEvents)[keyof typeof OmniEvents];

// Livechat-specific events (bridge layer)

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
  /**
   * A visitor message could not be accepted into the pipeline.
   *
   * Livechat has no provider redelivery, so the widget is told rather than left
   * waiting: the visitor sees the message failed and can resend it.
   */
  MESSAGE_REJECTED: 'livechat.message.rejected',
} as const;

export type LivechatEventName =
  (typeof LivechatEvents)[keyof typeof LivechatEvents];

// CRM domain events (non-omni)

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

// Event Payload Interfaces

/** Base shape shared by most omni events */
export interface OmniEventBase {
  tenantId: string;
  /**
   * Optional trace ID to correlate events across service boundaries.
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

export interface ConversationCreatedEvent extends OmniEventBase {
  conversationId: string;
  channelType: string;
  channelId: string;
  channelAccount: string;
  externalConversationId: string;
  contactId?: string | null;
}

export interface ConversationReopenedEvent extends OmniEventBase {
  conversationId: string;
  previousStatus?: string;
}

export interface ConversationStatusChangedEvent extends OmniEventBase {
  conversationId: string;
  oldStatus: string;
  newStatus: string;
  changedBy?: string;
}

export interface ConversationAssignedEvent extends OmniEventBase {
  conversationId: string;
  agentId: string | null;
  previousAgentId?: string | null;
  assignedBy?: string;
  reason?: string;
  channelType?: string;
}

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

export interface ConversationNoteAddedEvent extends OmniEventBase {
  conversationId: string;
  noteId: string;
  content: string;
  authorId: string;
  authorName?: string;
}

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

export interface ConversationTakeoverEvent extends OmniEventBase {
  conversationId: string;
  newAgentId: string;
  previousAgentId: string;
}

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

/**
 * omni.work_item.requeued — an offer lapsed or was declined and the work item
 * is back in the queue awaiting a fresh routing pass.
 */
export interface WorkItemRequeuedEvent extends OmniEventBase {
  conversationId: string;
  /** The agent who let the offer lapse — must not be picked again. */
  excludeAgentId: string;
  /** 1-based re-offer count, bounded by MAX_REDISPATCH_ATTEMPTS. */
  attempt: number;
  reason: string;
}

/** omni.bot.handoff — Bot handed off conversation to human agent */
export interface BotHandoffEvent extends OmniEventBase {
  conversationId: string;
  channelType: string;
  channelAccount: string;
  contactId: string | null;
  inboundMessageId?: string;
  sessionId?: string;
  handoff?: {
    target: 'general' | 'group' | 'agent';
    targetId: string | null;
    message: string | null;
  };
}

/** omni.bot.ended — Bot session finished without handing off */
export interface BotEndedEvent extends OmniEventBase {
  conversationId: string;
  channelType: string;
  channelAccount: string;
  contactId: string | null;
  inboundMessageId?: string;
  sessionId?: string;
  /** Why the session ended — `no_flow_bound` means the channel has no bot flow. */
  reason: 'flow_completed' | 'no_flow_bound';
}

export interface ReactionInboundEvent extends OmniEventBase {
  conversationId?: string;
  messageId?: string;
  senderId: string;
  emoji: string;
  action: 'set' | 'unset';
  channelType: string;
}

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

export interface ContactAutoMergedEvent extends OmniEventBase {
  primaryContactId: string;
  mergedContactId: string;
  reason: string;
}

export interface EscalationNotifyEvent extends OmniEventBase {
  conversationId: string;
  policyId: string;
  level: number;
  notifyUserIds: string[];
}

export interface EscalationReassignEvent extends OmniEventBase {
  conversationId: string;
  policyId: string;
  targetAgentId: string;
  previousAgentId?: string;
}

export interface LivechatMessageInboundEvent {
  visitorId: string;
  tenantId: string;
  channelId: string;
  text: string;
  metadata?: Record<string, any>;
  timestamp?: number;
}

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

export interface LivechatMessageStatusEvent {
  tenantId: string;
  conversationId: string;
  messageIds: string[];
  status: 'delivered' | 'read';
  visitorId?: string;
}

export interface LivechatAgentReadEvent {
  tenantId: string;
  conversationId: string;
  agentId: string;
  messageIds: string[];
}

export interface LivechatVisitorUploadCompletedEvent {
  tenantId: string;
  visitorId: string;
  fileName: string;
  mimeType: string;
}

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
