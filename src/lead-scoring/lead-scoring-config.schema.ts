import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../utils/document-entity-helper';
import { tenantFilterPlugin } from '../common/plugins/tenant-filter.plugin';

export type LeadScoringConfigDocument = HydratedDocument<LeadScoringConfigSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'lead_scoring_configs',
  toJSON: { virtuals: true, getters: true },
})
export class LeadScoringConfigSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
    unique: true,
  })
  tenantId: string;

  /** Minimum score floor (default: 0) */
  @Prop({ type: Number, default: 0 })
  scoreFloor: number;

  /** Maximum score ceiling (null = uncapped) */
  @Prop({ type: Number, default: null })
  scoreCeiling?: number | null;

  /** Threshold score to classify as Marketing Qualified Lead (MQL) */
  @Prop({ type: Number, default: 50 })
  mqlThreshold: number;

  /** Threshold score to classify as Sales Qualified Lead (SQL) */
  @Prop({ type: Number, default: 80 })
  sqlThreshold: number;

  /** Enable automatic lifecycle stage advancement when score threshold is crossed */
  @Prop({ type: Boolean, default: false })
  autoAdvanceLifecycle: boolean;

  /** Days of inactivity before score decay kicks in */
  @Prop({ type: Number, default: 14 })
  decayInactivityDays: number;

  /** Score decay percentage per sweep (e.g. 10 = 10%) */
  @Prop({ type: Number, default: 10 })
  decayPercentage: number;

  /** Minimum points deducted during decay sweep */
  @Prop({ type: Number, default: 5 })
  decayMinPoints: number;
}

export const LeadScoringConfigSchema = SchemaFactory.createForClass(
  LeadScoringConfigSchemaClass,
);
LeadScoringConfigSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
LeadScoringConfigSchema.index({ tenantId: 1 }, { unique: true });
