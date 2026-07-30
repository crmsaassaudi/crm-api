import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';

export type InboxDocument = HydratedDocument<InboxSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'omni_inboxes',
  toJSON: { virtuals: true, getters: true },
})
export class InboxSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
  })
  tenantId: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  name: string;

  @Prop({ type: String, required: true, trim: true, lowercase: true })
  key: string;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' })
  status: 'active' | 'archived';

  @Prop({ type: String, enum: ['open', 'restricted'], default: 'open' })
  visibilityMode: 'open' | 'restricted';

  @Prop({
    type: [{ type: MongooseSchema.Types.ObjectId, ref: 'GroupSchemaClass' }],
    default: [],
  })
  groupIds: string[];

  @Prop({
    type: [{ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' }],
    default: [],
  })
  userIds: string[];

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'AssignmentRuleSchemaClass',
    default: null,
  })
  routingRuleId: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SlaPolicySchemaClass',
    default: null,
  })
  slaPolicyId: string | null;

  @Prop({ type: String, default: null })
  botPolicyId: string | null;

  @Prop({ type: String, default: null })
  businessHoursId: string | null;

  @Prop({
    type: {
      version: { type: Number, default: 1 },
      capacityWeights: { type: MongooseSchema.Types.Mixed, default: {} },
      afterContactWorkSeconds: {
        type: MongooseSchema.Types.Mixed,
        default: {},
      },
    },
    _id: false,
    default: null,
  })
  capacityPolicy: {
    version: number;
    capacityWeights?: Record<string, number>;
    afterContactWorkSeconds?: Record<string, number>;
  } | null;
}

export const InboxSchema = SchemaFactory.createForClass(InboxSchemaClass);
InboxSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
InboxSchema.index(
  { tenantId: 1, key: 1 },
  { unique: true, name: 'inbox_tenant_key_unique' },
);
InboxSchema.index(
  { tenantId: 1, status: 1, name: 1 },
  { name: 'inbox_tenant_list' },
);
InboxSchema.index({ tenantId: 1, groupIds: 1 }, { name: 'inbox_groups' });
InboxSchema.index({ tenantId: 1, userIds: 1 }, { name: 'inbox_users' });
