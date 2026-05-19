import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProvisioningJobDocument = HydratedDocument<ProvisioningJobSchemaClass>;

@Schema({
  collection: 'provisioning_jobs',
  timestamps: true,
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (_doc, ret: Record<string, unknown>) => {
      delete ret.__v;
      return ret;
    },
  },
})
export class ProvisioningJobSchemaClass {
  @Prop({ required: true, unique: true, index: true })
  provisioningId: string;

  @Prop({ required: true, enum: ['PLG', 'SLG'] })
  source: 'PLG' | 'SLG';

  @Prop({
    required: true,
    enum: ['QUEUED', 'PROVISIONING', 'READY', 'FAILED'],
    index: true,
  })
  status: string;

  @Prop({ required: true })
  companyName: string;

  @Prop({ required: true })
  adminEmail: string;

  @Prop()
  alias?: string;

  @Prop()
  tenantId?: string;

  @Prop()
  currentStep?: number;

  @Prop()
  totalSteps?: number;

  @Prop()
  stepLabel?: string;

  @Prop()
  redirectUrl?: string;

  @Prop()
  error?: string;

  @Prop({ type: [Object], default: [] })
  events: Array<{
    status: string;
    step?: number;
    stepLabel?: string;
    message?: string;
    timestamp: Date;
  }>;
}

export const ProvisioningJobSchema = SchemaFactory.createForClass(
  ProvisioningJobSchemaClass,
);

// Index for support queries: find all jobs for a company/email
ProvisioningJobSchema.index({ adminEmail: 1, createdAt: -1 });
ProvisioningJobSchema.index({ companyName: 1, createdAt: -1 });
