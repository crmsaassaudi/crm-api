import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

// ── Sub-document types ─────────────────────────────────────────────────────

export interface WorkflowTriggerConfig {
  event: 'record_created' | 'field_updated';
  object: 'Lead' | 'Contact' | 'Ticket' | 'Deal' | 'Account' | 'Task';
  field?: string; // Only for field_updated
  runOncePerRecord: boolean;
}

export interface WorkflowNode {
  id: string; // Client-generated UUID
  type: 'trigger' | 'condition' | 'action';
  position: { x: number; y: number };
  config: Record<string, any>; // Type-specific JSON
}

export interface WorkflowEdge {
  id: string;
  source: string; // Node ID
  sourceHandle?: 'matched' | 'not_matched' | 'success' | 'failure'; // True/False Split + Action branching
  target: string; // Node ID
}

export interface WorkflowViewport {
  x: number;
  y: number;
  zoom: number;
}

export type WorkflowStatus = 'draft' | 'active' | 'paused';

// ── Schema ─────────────────────────────────────────────────────────────────

export type AutomationWorkflowDocument =
  HydratedDocument<AutomationWorkflowSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'automation_workflows',
  toJSON: { virtuals: true, getters: true },
})
export class AutomationWorkflowSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  description: string;

  @Prop({
    required: true,
    enum: ['draft', 'active', 'paused'],
    default: 'draft',
  })
  status: WorkflowStatus;

  @Prop({
    type: {
      event: {
        type: String,
        required: true,
        enum: ['record_created', 'field_updated'],
      },
      object: {
        type: String,
        required: true,
        enum: ['Lead', 'Contact', 'Ticket', 'Deal', 'Account', 'Task'],
      },
      field: { type: String, default: null },
      runOncePerRecord: { type: Boolean, default: false },
    },
    required: true,
  })
  triggerConfig: WorkflowTriggerConfig;

  @Prop({
    type: [
      {
        id: { type: String, required: true },
        type: {
          type: String,
          required: true,
          enum: ['trigger', 'condition', 'action'],
        },
        position: {
          x: { type: Number, required: true },
          y: { type: Number, required: true },
        },
        config: { type: MongooseSchema.Types.Mixed, default: {} },
      },
    ],
    default: [],
  })
  nodes: WorkflowNode[];

  @Prop({
    type: [
      {
        id: { type: String, required: true },
        source: { type: String, required: true },
        sourceHandle: {
          type: String,
          enum: ['matched', 'not_matched', 'success', 'failure', null],
          default: null,
        },
        target: { type: String, required: true },
      },
    ],
    default: [],
  })
  edges: WorkflowEdge[];

  @Prop({
    type: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
      zoom: { type: Number, default: 1 },
    },
    default: { x: 0, y: 0, zoom: 1 },
  })
  viewport: WorkflowViewport;

  @Prop({ default: 0 })
  executionCount: number;

  @Prop({ type: Date, default: null })
  lastExecutedAt: Date | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  createdBy: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  updatedBy: string;
}

export const AutomationWorkflowSchema = SchemaFactory.createForClass(
  AutomationWorkflowSchemaClass,
);

AutomationWorkflowSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// ── Indexes ────────────────────────────────────────────────────────────────

// List active workflows per tenant
AutomationWorkflowSchema.index({ tenantId: 1, status: 1 });

// Event matching — find workflows triggered by a specific event + object
AutomationWorkflowSchema.index({
  tenantId: 1,
  status: 1,
  'triggerConfig.event': 1,
  'triggerConfig.object': 1,
});

// Unique name per tenant
AutomationWorkflowSchema.index({ tenantId: 1, name: 1 }, { unique: true });
