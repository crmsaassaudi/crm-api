import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { SubscriptionPlan, TenantStatus } from '../../../../domain/tenant';

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
      limitMB: { type: Number, default: 1024 },
      usedMB: { type: Number, default: 0 },
    },
    default: () => ({ limitMB: 1024, usedMB: 0 }),
  })
  storageQuota: {
    limitMB: number;
    usedMB: number;
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
}

export const TenantSchema = SchemaFactory.createForClass(TenantSchemaClass);
