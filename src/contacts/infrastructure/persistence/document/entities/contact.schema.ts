import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type ContactSchemaDocument = HydratedDocument<ContactSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'contacts',
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (doc, ret: any) => {
      ret.version = ret.__v;
      delete ret.__v;
      return ret;
    },
  },
})
export class ContactSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, index: true })
  firstName: string;

  @Prop({ required: true, index: true })
  lastName: string;

  @Prop({ type: [String], default: [] })
  emails: string[];

  @Prop({ type: [String], default: [] })
  phones: string[];

  @Prop({ default: false })
  isConverted: boolean;

  @Prop({ required: true, index: true })
  lifecycleStage: string;

  @Prop({ required: true, index: true })
  status: string;

  @Prop()
  companyName?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AccountSchemaClass' })
  accountId?: string;

  @Prop()
  title?: string;

  @Prop()
  source?: string;

  @Prop()
  role?: string;

  @Prop()
  address?: string;

  @Prop()
  birthday?: Date;

  @Prop({ type: MongooseSchema.Types.Mixed })
  customFields?: Record<string, any>;

  @Prop({ default: 0 })
  score?: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  ownerId?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  createdById: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  updatedById: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop()
  deletedAt?: Date;

  // ────────────────── OMNI-CHANNEL / SHADOW CONTACT ──────────────────

  /**
   * Multiple omni-channel identities linked to this contact.
   * Each entry represents one social/messaging account
   * (e.g. Facebook PSID, Zalo User ID).
   */
  @Prop({
    type: [
      {
        channelType: { type: String, required: true },
        senderId: { type: String, required: true },
      },
    ],
    default: [],
  })
  omniIdentities: Array<{ channelType: string; senderId: string }>;

  /** Flag to indicate this is a temporary/anonymous contact created from a chat */
  @Prop({ default: false })
  isShadow: boolean;

  /** Flag to indicate this contact is a VIP customer (priority routing) */
  @Prop({ default: false, index: true })
  isVIP: boolean;

  // ────────────────── STAGE HISTORY TRACKING ──────────────────

  /**
   * Embedded log of all lifecycle stage transitions.
   * Each entry records: from → to, timestamp, who made the change, and optional reason.
   */
  @Prop({
    type: [
      {
        fromStage: { type: String, default: null },
        toStage: { type: String, required: true },
        changedAt: { type: Date, required: true, default: Date.now },
        changedById: {
          type: MongooseSchema.Types.ObjectId,
          ref: 'UserSchemaClass',
        },
        reason: { type: String },
      },
    ],
    default: [],
  })
  stageHistory: Array<{
    fromStage: string | null;
    toStage: string;
    changedAt: Date;
    changedById: string;
    reason?: string;
  }>;
}

export const ContactSchema = SchemaFactory.createForClass(ContactSchemaClass);

ContactSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
ContactSchema.index({ tenantId: 1, emails: 1 });
ContactSchema.index({ tenantId: 1, firstName: 1, lastName: 1 });
ContactSchema.index(
  { 'omniIdentities.channelType': 1, 'omniIdentities.senderId': 1 },
  { name: 'omni_identity_lookup' },
);
ContactSchema.index(
  { tenantId: 1, 'omniIdentities.senderId': 1 },
  { name: 'tenant_omni_sender' },
);
ContactSchema.index(
  { tenantId: 1, 'omniIdentities.senderId': 1, isVIP: 1 },
  { name: 'tenant_sender_vip_lookup' },
);
ContactSchema.index(
  { tenantId: 1, ownerId: 1 },
  { name: 'tenant_owner_lookup', sparse: false },
);

ContactSchema.virtual('owner', {
  ref: 'UserSchemaClass',
  localField: 'ownerId',
  foreignField: '_id',
  justOne: true,
});

ContactSchema.virtual('createdBy', {
  ref: 'UserSchemaClass',
  localField: 'createdById',
  foreignField: '_id',
  justOne: true,
});

ContactSchema.virtual('updatedBy', {
  ref: 'UserSchemaClass',
  localField: 'updatedById',
  foreignField: '_id',
  justOne: true,
});
