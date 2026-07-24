import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type AuthzAuditLogDocument = HydratedDocument<AuthzAuditLogSchemaClass>;

export type AuthzAuditCategory =
  | 'ROLE' // custom role definition changed
  | 'MEMBERSHIP' // a user's tenant roleIds / permissions / overrides changed
  | 'GROUP' // group permissions / roleIds / hierarchy changed
  | 'PLATFORM_ROLE' // platformRole (SUPER_ADMIN) changed
  | 'ASSIGNMENT'; // a governed role grant (JIT/time-bound) or its revocation

export type AuthzAuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'assign'
  | 'revoke';

/**
 * Append-only audit trail for authorization governance — WHO changed WHAT
 * about roles/permissions/assignments, and the before/after. Immutable:
 * only inserts, never updates/deletes (retention handled out of band).
 */
@Schema({ collection: 'authz_audit_logs', timestamps: { createdAt: 't', updatedAt: false } })
export class AuthzAuditLogSchemaClass {
  @Prop({ type: String, required: true, index: true })
  tenantId: string;

  /** Actor who performed the change (Mongo id or keycloak sub); 'system' for jobs. */
  @Prop({ type: String, required: true })
  actorId: string;

  @Prop({ type: String, default: null })
  actorEmail?: string | null;

  /** Kind of actor: 'user' | 'service' | 'agent' (defaults to user). */
  @Prop({ type: String, default: 'user' })
  actorType?: string;

  @Prop({ type: String, required: true })
  category: AuthzAuditCategory;

  @Prop({ type: String, required: true })
  action: AuthzAuditAction;

  /** What kind of entity was affected: 'custom_role' | 'user' | 'group'. */
  @Prop({ type: String, required: true })
  targetType: string;

  @Prop({ type: String, required: true })
  targetId: string;

  /** Human-readable one-liner (e.g. "assigned roles [Sales] to user X"). */
  @Prop({ type: String, default: null })
  summary?: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  before?: any;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  after?: any;

  @Prop({ type: String, default: null })
  ip?: string | null;

  t: Date; // createdAt (append time)
}

export const AuthzAuditLogSchema = SchemaFactory.createForClass(
  AuthzAuditLogSchemaClass,
);

// Primary read pattern: most-recent-first within a tenant, optionally by target.
AuthzAuditLogSchema.index({ tenantId: 1, t: -1 });
AuthzAuditLogSchema.index({ tenantId: 1, targetType: 1, targetId: 1, t: -1 });
AuthzAuditLogSchema.index({ tenantId: 1, category: 1, t: -1 });
