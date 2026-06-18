import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ObjectAclDocument = ObjectAcl & Document;

/**
 * ObjectAcl — record-level access control entry.
 *
 * Grants / Denies a specific action on a specific resource record
 * to a specific principal (user or group).
 *
 * Design:
 *   - ResourceType + ResourceId identify the CRM record (e.g. deals / 664abc...)
 *   - PrincipalType + PrincipalId identify who the grant applies to
 *   - Permissions is an allow-list of actions (view, edit, delete …)
 *   - Deny flag inverts the entry into an explicit deny (default: allow)
 *
 * Usage:
 *   ObjectAclService.can(userId, 'edit', 'deals', resourceId)
 */
@Schema({ collection: 'object_acl', timestamps: true })
export class ObjectAcl {
  /** Type of CRM resource: 'contacts' | 'deals' | 'tickets' | 'accounts' */
  @Prop({ required: true, index: true })
  resourceType: string;

  /** MongoDB ObjectId of the specific resource record */
  @Prop({ required: true, index: true })
  resourceId: string;

  /** 'user' | 'group' — identifies the principal kind */
  @Prop({ required: true, enum: ['user', 'group'] })
  principalType: 'user' | 'group';

  /** User ID or Group ID */
  @Prop({ required: true, index: true })
  principalId: string;

  /** Actions granted (or denied) by this entry, e.g. ['view', 'edit'] */
  @Prop({ type: [String], default: [] })
  permissions: string[];

  /** When true, this entry explicitly DENIES the listed permissions */
  @Prop({ default: false })
  isDeny: boolean;

  /** Tenant scope */
  @Prop({ required: true, index: true })
  tenantId: string;
}

export const ObjectAclSchema = SchemaFactory.createForClass(ObjectAcl);

// Compound index for fast per-resource look-up
ObjectAclSchema.index({ resourceType: 1, resourceId: 1, tenantId: 1 });
// Compound index for per-principal look-up (e.g. "which records can this user view?")
ObjectAclSchema.index({ principalType: 1, principalId: 1, tenantId: 1 });
