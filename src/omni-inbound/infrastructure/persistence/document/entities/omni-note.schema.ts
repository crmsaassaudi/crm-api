import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type OmniNoteDocument = HydratedDocument<OmniNoteSchemaClass>;

/**
 * Schema for private/public agent notes on conversations.
 * Notes are NOT messages — they are internal annotations visible only to agents.
 */
@Schema({
  timestamps: true,
  collection: 'omni_notes',
  toJSON: { virtuals: true, getters: true },
})
export class OmniNoteSchemaClass extends EntityDocumentHelper {
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

  @Prop({ required: true })
  content: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  authorId: string;

  /** User IDs of agents @mentioned in the note */
  @Prop({ type: [String], default: [] })
  mentions: string[];

  /** If true, note is only visible to agents (not synced to platform) */
  @Prop({ default: true })
  isPrivate: boolean;

  /**
   * If true, this note is pinned as a Handover Note — displayed as a
   * sticky context banner at the top of the chat window for newly assigned agents.
   * Only one pinned note per conversation is expected at a time.
   */
  @Prop({ default: false })
  isPinned: boolean;
}

export const OmniNoteSchema = SchemaFactory.createForClass(OmniNoteSchemaClass);

OmniNoteSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Index for fetching notes by conversation
OmniNoteSchema.index(
  { tenantId: 1, conversationId: 1, createdAt: -1 },
  { name: 'notes_by_conversation' },
);

// Index for fast pinned-note lookup
OmniNoteSchema.index(
  { conversationId: 1, isPinned: 1 },
  { name: 'notes_pinned_lookup' },
);
