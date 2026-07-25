import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CustomRoleDocument = CustomRoleSchemaClass & Document;

@Schema({ collection: 'custom_roles', timestamps: true })
export class CustomRoleSchemaClass {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: '' })
  description: string;

  /** Tenant this role belongs to */
  @Prop({ required: true, index: true })
  tenantId: string;

  /**
   * Array of permission keys from PERMISSION_REGISTRY.
   * e.g. ['contacts:view', 'deals:create']
   */
  @Prop({ type: [String], default: [] })
  permissions: string[];

  /**
   * System roles are materialised from SYSTEM_ROLE_TEMPLATES on tenant creation.
   * They are immutable: the API rejects update and delete, admins clone them
   * instead. Examples: "Sales Rep", "Support Agent".
   */
  @Prop({ default: false })
  isSystem: boolean;

  /**
   * Stable template identity for system roles (e.g. 'sys.sales_rep').
   * Unset on tenant-authored roles. This — not the name — is what lets the
   * seeder recognise and re-sync a role it created earlier.
   */
  @Prop({ type: String, default: null })
  systemKey?: string | null;

  /**
   * Version of the template this row was materialised from. The seeder
   * re-syncs rows whose version is behind SYSTEM_ROLE_TEMPLATES.
   */
  @Prop({ type: Number, default: null })
  templateVersion?: number | null;

  /** Color accent for UI display */
  @Prop({ default: '#6366f1' })
  color: string;
}

export const CustomRoleSchema = SchemaFactory.createForClass(
  CustomRoleSchemaClass,
);

// Compound unique index: name is unique per tenant
CustomRoleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

// One row per system template per tenant. Partial (not sparse) so tenant-authored
// roles — which store systemKey: null rather than omitting it — don't collide.
CustomRoleSchema.index(
  { tenantId: 1, systemKey: 1 },
  {
    unique: true,
    partialFilterExpression: { systemKey: { $type: 'string' } },
  },
);
