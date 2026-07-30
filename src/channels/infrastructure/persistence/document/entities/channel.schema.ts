import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type ChannelSchemaDocument = HydratedDocument<ChannelSchemaClass>;

const CHANNEL_TYPES = [
  'facebook',
  'zalo',
  'whatsapp',
  'livechat',
  'instagram',
  'tiktok',
  'shopee',
  'email',
];

@Schema({
  timestamps: true,
  collection: 'channels',
  toJSON: { virtuals: true, getters: true },
})
export class ChannelSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: String,
    required: true,
    enum: CHANNEL_TYPES,
  })
  type: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  account: string;

  /** Operational inbox that owns routing, visibility, SLA and bot policy. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'InboxSchemaClass',
    default: null,
    index: true,
  })
  inboxId: string | null;

  @Prop({
    type: String,
    required: true,
    enum: ['Connected', 'Disconnected', 'Error', 'Pending'],
    default: 'Pending',
  })
  status: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  config: Record<string, any>;

  /**
   * Who is allowed to serve this channel. A real subdocument rather than a
   * `config` key: this drives authorization (who may be assigned, who may see
   * the conversation), so it needs refs, validation and indexes — `config` is
   * Mixed and gives none of those.
   *
   * mode:
   *   - 'restricted' → only (userIds ∪ members(groupIds)) \ excludedUserIds may
   *     be assigned to, or read, this channel's conversations. Empty pool means
   *     nobody but admins.
   *   - 'open'       → every agent in the tenant may serve the channel; the
   *     lists are then only a routing preference, not an authorization boundary.
   */
  @Prop({
    type: {
      userIds: {
        type: [{ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' }],
        default: [],
      },
      groupIds: {
        type: [
          { type: MongooseSchema.Types.ObjectId, ref: 'GroupSchemaClass' },
        ],
        default: [],
      },
      excludedUserIds: {
        type: [{ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' }],
        default: [],
      },
      mode: { type: String, enum: ['restricted', 'open'], default: 'open' },
    },
    default: () => ({
      userIds: [],
      groupIds: [],
      excludedUserIds: [],
      mode: 'open',
    }),
  })
  support: {
    userIds: string[];
    groupIds: string[];
    excludedUserIds: string[];
    mode: 'restricted' | 'open';
  };

  /**
   * Per-channel override of the tenant's `data_visibility.defaultAccess`
   * setting (M18). Independent of `support`: `support.mode` decides who may
   * be ASSIGNED to / SERVE this channel at all; `visibility` decides, among
   * those who can serve it, whether they see only their own scope's
   * conversations or every conversation on the channel.
   *
   * - 'inherit'     → use the tenant-wide `defaultAccess` (default).
   * - 'private'     → this channel's conversations always follow the
   *   viewer's normal owner/org-unit scope, even under a tenant-wide
   *   `public_read` default.
   * - 'public_read' → this channel's conversations are visible to anyone who
   *   can serve the channel, even under a tenant-wide `private` default.
   */
  @Prop({
    type: String,
    enum: ['inherit', 'private', 'public_read'],
    default: 'inherit',
  })
  visibility: 'inherit' | 'private' | 'public_read';

  // Sensitive credentials — never returned in list API
  @Prop({ type: MongooseSchema.Types.Mixed, select: false })
  credentials: Record<string, any>;
}

export const ChannelSchema = SchemaFactory.createForClass(ChannelSchemaClass);

ChannelSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
ChannelSchema.index({ tenantId: 1, type: 1, account: 1 }, { unique: true });
// CRIT-03: Enforce global uniqueness — same provider account cannot be
// connected to multiple tenants. Application guard exists in
// assertChannelAccountAvailable, but DB uniqueness provides defense-in-depth.
ChannelSchema.index({ type: 1, account: 1 }, { unique: true });
// Reverse lookup: "which channels may this user / group serve?" — read on every
// conversation-list request to build the visibility scope, so it must be indexed.
ChannelSchema.index({ tenantId: 1, 'support.userIds': 1 });
ChannelSchema.index({ tenantId: 1, 'support.groupIds': 1 });
