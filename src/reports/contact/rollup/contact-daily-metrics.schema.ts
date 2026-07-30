import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../utils/document-entity-helper';

export type ContactDailyMetricsDocument =
  HydratedDocument<ContactDailyMetricsSchemaClass>;

/**
 * Pre-aggregated daily contact counts, one row per
 * `(tenantId, day, timezone, ownerId, orgUnitId)`.
 *
 * The growth-trend report scans the whole `contacts` collection with a `$facet` on
 * every dashboard load. At 100M contacts that is the single most expensive read in
 * the product, and it runs on the most-visited screen. This collection answers the
 * same question from ~one row per owner per day.
 *
 * Two schema decisions carry the correctness of the whole thing:
 *
 * **`timezone` is stored on the row, not assumed.** Day boundaries depend on it —
 * a contact created at 23:30 UTC falls on a different day in Asia/Ho_Chi_Minh than
 * in UTC. A rollup bucketed in one zone cannot serve a request in another, and the
 * error is invisible: the totals still look plausible, they are just attributed to
 * the wrong days. The reader requires an exact match rather than converting.
 *
 * **`ownerId` and `orgUnitId` are dimensions, not filters.** Every contact
 * contributes to exactly one `(owner, orgUnit)` bucket, so the report's visibility
 * predicate — `ownerId ∈ visible OR orgUnitId ∈ visible` — can be applied to these
 * rows and give the identical answer. Without them the rollup could only ever serve
 * an unrestricted admin, which is not the common case.
 *
 * Anything the rollup does NOT carry as a dimension (isVIP, sourceId, stageId,
 * channel, ABAC predicates) means the request falls back to the live aggregation.
 * See `canServeFromRollup`.
 */
@Schema({ timestamps: true, collection: 'contact_daily_metrics' })
export class ContactDailyMetricsSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  /** `YYYY-MM-DD` in `timezone`. A string, so it is comparable without date maths. */
  @Prop({ required: true })
  day: string;

  /** IANA zone the day boundaries were computed in. */
  @Prop({ required: true })
  timezone: string;

  /** Null for contacts with no owner — a real bucket, not an absence of one. */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  ownerId?: string | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  orgUnitId?: string | null;

  /**
   * Contacts created on this day, regardless of whether they were later deleted —
   * matching the live query, which passes `skipSoftDelete` for this series.
   * A "created" count that shrinks when a record is deleted is not a growth metric.
   */
  @Prop({ default: 0 })
  created: number;

  /** Contacts soft-deleted on this day. */
  @Prop({ default: 0 })
  deleted: number;

  /** When this bucket was last computed — surfaced so a stale rollup is visible. */
  @Prop({ type: Date })
  computedAt?: Date;
}

export const ContactDailyMetricsSchema = SchemaFactory.createForClass(
  ContactDailyMetricsSchemaClass,
);

// NOTE: deliberately NO tenantFilterPlugin. The rollup job runs in a worker with no
// request context, where the plugin's CLS lookup yields nothing and would silently
// scope every query to "no tenant" — a job that appears to run and writes nothing.
// Every query below passes tenantId explicitly instead.

// The upsert key. Unique so a re-run recomputes a bucket rather than doubling it —
// the rollup job must be safely repeatable, including after a partial failure.
ContactDailyMetricsSchema.index(
  { tenantId: 1, day: 1, timezone: 1, ownerId: 1, orgUnitId: 1 },
  { name: 'rollup_bucket_key', unique: true },
);

// The read path: a tenant's buckets across a date range, in one timezone.
ContactDailyMetricsSchema.index(
  { tenantId: 1, timezone: 1, day: 1 },
  { name: 'rollup_range_read' },
);
