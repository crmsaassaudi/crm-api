import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RoleAssignmentDocument = HydratedDocument<RoleAssignmentSchemaClass>;

/** Who a role is granted to. Mirrors the two RBAC subject kinds. */
export type AssignmentPrincipalType = 'user' | 'group';

/**
 * RoleAssignment — a first-class, auditable grant of a custom role to a
 * principal, with optional time-bounding (JIT / just-in-time access).
 *
 * This complements the *permanent* role references embedded on a user
 * membership / group (`roleIds[]`): those are the standing role set; a
 * RoleAssignment is a governed grant that records WHO granted it, WHEN, WHY,
 * and (optionally) WHEN it expires or was revoked. A grant with a future
 * `expiresAt` is a temporary elevation; the engine stops honoring it the
 * moment it lapses.
 *
 * Append-and-mark model: revocation sets `revokedAt` rather than deleting, so
 * the grant history is preserved for compliance. "Active" = not revoked AND
 * not past `expiresAt`.
 */
@Schema({ collection: 'role_assignments', timestamps: true })
export class RoleAssignmentSchemaClass {
  @Prop({ type: String, required: true, index: true })
  tenantId: string;

  @Prop({ type: String, required: true, enum: ['user', 'group'] })
  principalType: AssignmentPrincipalType;

  @Prop({ type: String, required: true })
  principalId: string;

  /** The custom role being granted (references CustomRole._id). */
  @Prop({ type: String, required: true })
  roleId: string;

  @Prop({ type: String, required: true })
  grantedById: string;

  /** null → permanent grant; a Date → JIT/temporary, lapses at this instant. */
  @Prop({ type: Date, default: null })
  expiresAt?: Date | null;

  @Prop({ type: String, default: null })
  reason?: string | null;

  /** Set on revoke (soft). null → still active. */
  @Prop({ type: Date, default: null })
  revokedAt?: Date | null;

  @Prop({ type: String, default: null })
  revokedById?: string | null;
}

export const RoleAssignmentSchema = SchemaFactory.createForClass(
  RoleAssignmentSchemaClass,
);

// Hot path: resolve a principal's active grants at permission-eval time.
RoleAssignmentSchema.index({ tenantId: 1, principalId: 1, revokedAt: 1 });
// Admin listing + role-scoped invalidation.
RoleAssignmentSchema.index({ tenantId: 1, roleId: 1 });
