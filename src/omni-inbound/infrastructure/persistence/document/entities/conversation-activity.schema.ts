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
  'tag_added',
  'tag_removed',
  'note_added',
  'note_deleted',
  'priority_changed',
  'message_sent',
  'auto_resolved',
  'sla_breached',
  'escalated',
  'ticket_created',
  'deal_created',
  'identity_merged',
  'agent_rejected',
  'agent_transferred',
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

  @Prop({ required: true, enum: ACTOR_TYPES })
  actorType: string;

  /** null for system-generated activities */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  actorId: string | null;

  @Prop({ required: true, enum: ACTIVITY_ACTIONS })
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
