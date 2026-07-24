import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { AbacCondition, PolicyEffect } from './abac.evaluator';

export type AccessPolicyDocument = HydratedDocument<AccessPolicySchemaClass>;

/**
 * AccessPolicy — a tenant-scoped ABAC rule layered on top of RBAC.
 *
 * Matched by (resource, action) — with '*' wildcards — then its conditions are
 * evaluated against the request context. A DENY policy withdraws access even
 * when RBAC granted it (deny-overrides); an ALLOW policy widens beyond the
 * default owner scope. Standard use: "deny edit deal when stage == closed",
 * "allow view when resource.ownerId == subject.id".
 */
@Schema({ collection: 'access_policies', timestamps: true })
export class AccessPolicySchemaClass {
  @Prop({ type: String, required: true, index: true })
  tenantId: string;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, default: '' })
  description?: string;

  /** Resource key (e.g. 'deals') or '*' for any. */
  @Prop({ type: String, required: true })
  resource: string;

  /** Action (e.g. 'edit') or '*' for any. */
  @Prop({ type: String, required: true })
  action: string;

  @Prop({ type: String, required: true, enum: ['allow', 'deny'] })
  effect: PolicyEffect;

  @Prop({ type: MongooseSchema.Types.Mixed, default: [] })
  conditions: AbacCondition[];

  @Prop({ type: Boolean, default: true })
  active: boolean;

  /** Lower runs first; deny-overrides makes order non-critical but stable. */
  @Prop({ type: Number, default: 100 })
  priority: number;
}

export const AccessPolicySchema = SchemaFactory.createForClass(
  AccessPolicySchemaClass,
);

// Hot path: fetch a tenant's active policies for a resource/action.
AccessPolicySchema.index({ tenantId: 1, resource: 1, action: 1, active: 1 });
