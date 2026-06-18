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
   * System roles are pre-seeded and cannot be deleted.
   * Examples: "Sales Agent", "Support Agent"
   */
  @Prop({ default: false })
  isSystem: boolean;

  /** Color accent for UI display */
  @Prop({ default: '#6366f1' })
  color: string;
}

export const CustomRoleSchema = SchemaFactory.createForClass(
  CustomRoleSchemaClass,
);

// Compound unique index: name is unique per tenant
CustomRoleSchema.index({ tenantId: 1, name: 1 }, { unique: true });
