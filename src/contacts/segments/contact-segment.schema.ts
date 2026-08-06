import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';
import { FilterGroup } from '../filters/contact-filter';

export type ContactSegmentDocument =
  HydratedDocument<ContactSegmentSchemaClass>;

export const SEGMENT_TYPES = ['dynamic', 'static'] as const;
export type SegmentType = (typeof SEGMENT_TYPES)[number];

/**
 * A named audience, stored per tenant so it can be shared, exported and reported
 * on — unlike a List View (columns only) or a browser-local saved view.
 *
 * Two kinds, because B2C needs both:
 *   dynamic — a stored condition tree, evaluated at read time. Membership moves
 *             on its own: "no purchase in 90 days" empties as people buy.
 *   static  — an explicit id list. A campaign that was sent must keep the exact
 *             audience it went to; recomputing it later rewrites history.
 *
 * Hard-deleted: a segment is a definition with nothing referencing it, and a
 * soft delete with no recycle bin behind it is strictly worse than a hard one.
 */
@Schema({ timestamps: true, collection: 'contact_segments' })
export class ContactSegmentSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ type: String, required: true, enum: SEGMENT_TYPES })
  type: SegmentType;

  /**
   * The condition tree, for a dynamic segment. Stored as supplied and compiled
   * by `compileContactFilter` on every read, so a segment can never outlive the
   * validation rules — an operator removed from the compiler starts failing
   * loudly instead of quietly matching nothing.
   */
  @Prop({ type: MongooseSchema.Types.Mixed })
  filter?: FilterGroup;

  /** Explicit membership, for a static segment. */
  @Prop({
    type: [{ type: MongooseSchema.Types.ObjectId, ref: 'ContactSchemaClass' }],
    default: [],
  })
  memberIds: string[];

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
}

export const ContactSegmentSchema = SchemaFactory.createForClass(
  ContactSegmentSchemaClass,
);

ContactSegmentSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// One name per tenant: two segments called "VIP" is how the wrong audience gets
// picked.
ContactSegmentSchema.index(
  { tenantId: 1, name: 1 },
  { name: 'tenant_segment_name', unique: true },
);

ContactSegmentSchema.index(
  { tenantId: 1, updatedAt: -1 },
  { name: 'tenant_segment_list' },
);
