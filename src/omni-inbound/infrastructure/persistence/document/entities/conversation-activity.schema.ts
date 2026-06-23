import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type ConversationActivityDocument =
  HydratedDocument<ConversationActivitySchemaClass>;

const ACTIVITY_ACTIONS = [
  'conversation_created',
  'conversation_reopened',
  'status_changed',
  'agent_assigned',
  'agent_unassigned',
  'group_assigned',
  'group_unassigned',
  'tag_added',
  'tag_removed',
  'note_added',
  'note_deleted',
  // 'priority_changed',  // T13: no handler in ActivityService — implement when priority feature ships
  // 'message_sent',      // T13: no handler — omni.message.sent listener not connected to ActivityService
  'auto_resolved',
  'sla_breached',
  'escalated',
  'ticket_created',
  'deal_created',
  'identity_merged',
  // 'agent_rejected',    // T13: no handler — implement if rejection flow is added
  // 'agent_transferred', // T13: no handler — manual transfer uses agent_assigned instead
  'conversation_takeover',
] as const;

const ACTOR_TYPES = ['agent', 'system', 'customer'] as const;

/**
 * Immutable audit trail for conversation lifecycle events.
 * Each entry records a single action with before/after values.
 */
@Schema({
  timestamps: true,
  collection: 'omni_conversation_activities',
  toJSON: { virtuals: true, getters: true },
})
export class ConversationActivitySchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniConversationSchemaClass',
    required: true,
    index: true,
  })
  conversationId: string;

  @Prop({
    type: String,
    required: true,
    enum: ACTOR_TYPES,
  })
  actorType: string;

  /** null for system-generated activities */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  actorId: string | null;

  @Prop({
    type: String,
    required: true,
    enum: ACTIVITY_ACTIONS,
  })
  action: string;

  /** Previous value (for status/assignment changes) */
  @Prop({ type: String, default: null })
  oldValue: string | null;

  /** New value (for status/assignment changes) */
  @Prop({ type: String, default: null })
  newValue: string | null;

  /** Additional context (e.g. note preview, reason) */
  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;

  /** Human-readable description for inline system message display */
  @Prop({ type: String, default: null })
  description: string | null;
}

export const ConversationActivitySchema = SchemaFactory.createForClass(
  ConversationActivitySchemaClass,
);

ConversationActivitySchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Fetch activities per conversation, newest first
ConversationActivitySchema.index(
  { tenantId: 1, conversationId: 1, createdAt: -1 },
  { name: 'activities_by_conversation' },
);

// Cross-conversation actor queries: "what did agent X do today?"
ConversationActivitySchema.index(
  { tenantId: 1, actorId: 1, createdAt: -1 },
  { name: 'activities_by_actor' },
);

// P0 fix: TTL index — auto-delete entries older than 180 days.
// Without this the collection grows ~5M documents/day at production scale
// (1M conversations × ~5 events each), degrading all inbox queries over time.
// Adjust TTL to match your compliance/audit retention requirements.
ConversationActivitySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 180 * 24 * 60 * 60, name: 'activity_ttl_180d' },
);
