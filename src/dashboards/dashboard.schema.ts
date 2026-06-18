import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, HydratedDocument } from 'mongoose';

export type DashboardDocument = HydratedDocument<DashboardSchemaClass>;

/**
 * A single widget item placed on the dashboard grid.
 * Grid is 12-column based; x/y/w/h in grid units.
 */
export class DashboardWidget {
  /** Unique within the dashboard (e.g. nanoid) */
  @Prop({ required: true }) id: string;
  /** Widget type identifier maps to a known widget component */
  @Prop({ required: true }) type: string;
  /** Grid column start (0-11) */
  @Prop({ default: 0 }) x: number;
  /** Grid row start */
  @Prop({ default: 0 }) y: number;
  /** Width in columns (1-12) */
  @Prop({ default: 6 }) w: number;
  /** Height in rows */
  @Prop({ default: 4 }) h: number;
  /** Widget-specific config (title override, metric, filters, etc.) */
  @Prop({ type: Object, default: {} }) config: Record<string, any>;
}

@Schema({ timestamps: true, collection: 'dashboards' })
export class DashboardSchemaClass extends Document {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) name: string;
  @Prop() description?: string;
  /** JSON layout — array of widget descriptors */
  @Prop({ type: [Object], default: [] }) widgets: DashboardWidget[];
  /** Owner userId — dashboards are per-user unless isShared=true */
  @Prop({ required: true }) ownerId: string;
  /** Shared dashboards are visible to all tenant members (read-only) */
  @Prop({ default: false }) isShared: boolean;
  /** Icon emoji or lucide icon name for nav display */
  @Prop({ default: 'LayoutDashboard' }) icon: string;
}

export const DashboardSchema =
  SchemaFactory.createForClass(DashboardSchemaClass);

// Indexes
DashboardSchema.index({ tenantId: 1, ownerId: 1 });
DashboardSchema.index({ tenantId: 1, isShared: 1 });
