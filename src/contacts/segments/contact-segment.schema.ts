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

  /**
   * How many contacts matched when the definition was last saved.
   *
   * Stored so a picker can show a size without counting: the count is an
   * aggregate over every contact in the tenant, and running one per row of a
   * dropdown is how a segment list takes ten seconds to open. Deliberately
   * tenant-wide and NOT narrowed by the reader's data scope — it is a property
   * of the segment, not of whoever is looking at it, and the campaign preview
   * shows the scoped figure separately.
   *
   * `null` when the count could not be produced in time; the UI shows the
   * timestamp rather than pretending the number is current.
   */
  @Prop({ type: Number, default: null })
  cachedCount?: number | null;

  @Prop({ type: Date, default: null })
  countedAt?: Date | null;

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
