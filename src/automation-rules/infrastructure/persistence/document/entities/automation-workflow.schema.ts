import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { WorkflowRunAs } from '../../../../domain/execution-principal';
import { AutomationCrmModule } from '../../../../events/automation-event.payload';

// Sub-document types

/**
 * `object` is typed from AutomationCrmModule rather than repeated inline.
 *
 * The inline list omitted Conversation and Message while the DTO, the event
 * bridge, the action processor's record-type check and the execution-log schema
 * all accepted them — so `POST /automation-workflows` with an omni trigger threw
 * a Mongoose enum ValidationError, and the only way such a workflow could exist
 * was to create it as something else and PATCH it (findOneAndUpdate does not run
 * validators). Omni automation was reachable everywhere except where a user
 * could switch it on.
 */
export interface WorkflowTriggerConfig {
  event: 'record_created' | 'field_updated';
  object: AutomationCrmModule;
  field?: string; // Only for field_updated
  runOncePerRecord: boolean;
}

export interface WorkflowNode {
  id: string; // Client-generated ULID
  type: 'trigger' | 'condition' | 'action' | 'wait';
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

/** One source for the type, the Mongo enum and the query DTO's whitelist. */
export const WORKFLOW_STATUSES = ['draft', 'active', 'paused'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

// Schema

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
    type: String,
    required: true,
    enum: [...WORKFLOW_STATUSES],
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
        enum: [
          'Lead',
          'Contact',
          'Ticket',
          'Deal',
          'Account',
          'Task',
          'Conversation',
          'Message',
        ],
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
          enum: ['trigger', 'condition', 'action', 'wait'],
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

  /**
   * Which principal this workflow's actions execute as. See {@link WorkflowRunAs}.
   *
   * Defaults to `creator` — the least-privilege choice, and the same default the
   * service applies. It used to default to `system` (full tenant scope) to
   * preserve the behaviour of workflows authored before the field existed; there
   * are none, and a schema whose default is the escalation is a trap waiting for
   * the first write path that forgets to pass the field.
   */
  @Prop({
    type: String,
    enum: ['system', 'creator', 'trigger_user', 'record_owner'],
    default: 'creator',
  })
  runAs: WorkflowRunAs;

  /**
   * Acting user's Mongo id, or a non-user label like `system`.
   *
   * String rather than a required ObjectId ref for the same reason as
   * `automation_audit_logs.userId`: the service's actor fallback is the literal
   * `'system'`, which an ObjectId field cannot store — it throws a CastError.
   * A field that cannot represent every actor the code passes is a field that
   * loses writes.
   */
  @Prop({ type: String, required: true })
  createdBy: string;

  @Prop({ type: String, required: true })
  updatedBy: string;

  // Published Snapshot (Immutable Execution State)

  @Prop({
    type: [
      {
        id: { type: String, required: true },
        type: {
          type: String,
          required: true,
          enum: ['trigger', 'condition', 'action', 'wait'],
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
  publishedNodes: WorkflowNode[];

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
  publishedEdges: WorkflowEdge[];

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
        enum: [
          'Lead',
          'Contact',
          'Ticket',
          'Deal',
          'Account',
          'Task',
          'Conversation',
          'Message',
        ],
      },
      field: { type: String, default: null },
      runOncePerRecord: { type: Boolean, default: false },
    },
    default: null,
  })
  publishedTriggerConfig: WorkflowTriggerConfig | null;

  @Prop({ type: Date, default: null })
  publishedAt: Date | null;

  @Prop({ default: 0 })
  version: number;
}

export const AutomationWorkflowSchema = SchemaFactory.createForClass(
  AutomationWorkflowSchemaClass,
);

AutomationWorkflowSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Indexes

// List active workflows per tenant
AutomationWorkflowSchema.index({ tenantId: 1, status: 1 });

// Event matching — Orchestrator hot-path: find active workflows by PUBLISHED trigger config
AutomationWorkflowSchema.index({
  tenantId: 1,
  status: 1,
  'publishedTriggerConfig.event': 1,
  'publishedTriggerConfig.object': 1,
});

// Unique name per tenant
AutomationWorkflowSchema.index({ tenantId: 1, name: 1 }, { unique: true });
