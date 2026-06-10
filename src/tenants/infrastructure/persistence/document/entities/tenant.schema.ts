import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import {
  SubscriptionPlan,
  TenantStatus,
  ProvisioningStatus,
} from '../../../../domain/tenant';

export type TenantSchemaDocument = HydratedDocument<TenantSchemaClass>;

@Schema({
  timestamps: true,
  optimisticConcurrency: true,
  versionKey: '__v',
  collection: 'tenants',
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (_doc, ret: Record<string, unknown>) => {
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
})
export class TenantSchemaClass extends EntityDocumentHelper {
  @Prop({ required: true, unique: true, index: true })
  keycloakOrgId: string;

  @Prop({ required: true, unique: true, index: true })
  alias: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, default: '' })
  logoUrl: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    index: true,
  })
  ownerId: Types.ObjectId | null;

  @Prop({
    type: String,
    enum: Object.values(SubscriptionPlan),
    default: SubscriptionPlan.FREE,
  })
  subscriptionPlan: SubscriptionPlan;

  @Prop({
    type: String,
    enum: Object.values(TenantStatus),
    default: TenantStatus.ACTIVE,
  })
  status: TenantStatus;

  @Prop({
    type: String,
    enum: Object.values(ProvisioningStatus),
    default: ProvisioningStatus.READY,
  })
  provisioningStatus: ProvisioningStatus;

  @Prop({ type: String, default: null })
  provisioningError?: string;

  @Prop({ type: String, default: null })
  onboardingGoal?: string;

  @Prop({ type: String, default: null })
  botWorkspaceId?: string;

  @Prop({
    type: {
      resolveNoteMode: {
        type: String,
        enum: ['disabled', 'optional', 'required'],
        default: 'optional',
      },
    },
    default: () => ({ resolveNoteMode: 'optional' }),
  })
  omniSettings: {
    resolveNoteMode: 'disabled' | 'optional' | 'required';
  };

  @Prop({
    type: {
      limitBytes: { type: Number, default: 1073741824 }, // 1 GB
      usedBytes: { type: Number, default: 0 },
      warnThresholdPercent: { type: Number, default: 80 },
      lastRecalculatedAt: { type: Date, default: null },
    },
    default: () => ({
      limitBytes: 1073741824,
      usedBytes: 0,
      warnThresholdPercent: 80,
    }),
  })
  storageQuota: {
    limitBytes: number;
    usedBytes: number;
    warnThresholdPercent: number;
    lastRecalculatedAt?: Date;
  };

  @Prop({
    type: {
      omni_media: {
        type: { count: Number, sizeBytes: Number },
        default: { count: 0, sizeBytes: 0 },
      },
      ticket_attachment: {
        type: { count: Number, sizeBytes: Number },
        default: { count: 0, sizeBytes: 0 },
      },
      general: {
        type: { count: Number, sizeBytes: Number },
        default: { count: 0, sizeBytes: 0 },
      },
      lastCalculatedAt: { type: Date, default: null },
    },
    default: null,
  })
  storageBreakdown?: {
    omni_media: { count: number; sizeBytes: number };
    ticket_attachment: { count: number; sizeBytes: number };
    general: { count: number; sizeBytes: number };
    lastCalculatedAt?: Date;
  };

  @Prop({
    type: {
      locale: { type: String, default: 'en' },
      timezone: { type: String, default: 'UTC' },
      dateFormat: { type: String, default: 'MM/DD/YYYY' },
      currency: { type: String, default: 'USD' },
    },
    default: () => ({
      locale: 'en',
      timezone: 'UTC',
      dateFormat: 'MM/DD/YYYY',
      currency: 'USD',
    }),
  })
  i18nSettings: {
    locale: string;
    timezone: string;
    dateFormat: string;
    currency: string;
  };

  /**
   * Explicit list of FEATURE permission keys granted to this tenant.
   * Null (default) → tenant has only CORE_PERMISSIONS.
   * Non-empty array → tenant has CORE_PERMISSIONS + these extra keys.
   */
  @Prop({ type: [String], default: null })
  availablePermissions: string[] | null;

  /**
   * Explicit list of CORE permission keys disabled for this tenant.
   * Empty/default means the full CORE_PERMISSIONS baseline is enabled.
   */
  @Prop({ type: [String], default: [] })
  disabledCorePermissions: string[];
}

export const TenantSchema = SchemaFactory.createForClass(TenantSchemaClass);
