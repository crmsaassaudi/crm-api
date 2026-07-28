import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { DATA_SCOPE_ORDER, DataScope } from './data-scope.enum';
import { tenantFilterPlugin } from '../plugins/tenant-filter.plugin';

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

  /**
   * How wide a read scope this role grants inside the tenant.
   *
   * Scope lives on the role, not on the user, because it is part of what a job
   * title means: "Sales Manager" implies seeing the team's pipeline the same way
   * it implies `deals:edit`. Putting it on the user instead would make it
   * invisible in the role catalogue and unauditable — you could not answer "who
   * can see the whole branch?" by reading roles.
   *
   * A user holding several roles gets the WIDEST of their scopes (`maxScope`),
   * matching how `permissions` unions rather than intersects. Narrowing is
   * expressed with an explicit ABAC deny policy, never by adding a role.
   *
   * Null means the role expresses no opinion and contributes nothing, so the
   * tenant default applies. It is not a synonym for TENANT.
   */
  @Prop({
    type: String,
    enum: DATA_SCOPE_ORDER,
    default: null,
  })
  dataScope?: DataScope | null;

  /** Color accent for UI display */
  @Prop({ default: '#6366f1' })
  color: string;

  @Prop({ type: Number, default: 1 })
  revision: number;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  versions: Array<{
    revision: number;
    snapshot: Record<string, unknown>;
    publishedAt: Date;
    publishedById: string;
    sourceRevision?: number | null;
  }>;
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
CustomRoleSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
