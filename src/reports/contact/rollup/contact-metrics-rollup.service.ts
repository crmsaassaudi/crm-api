import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ContactSchemaClass } from '../../../contacts/infrastructure/persistence/document/entities/contact.schema';
import {
  RedisLockService,
  isLockContention,
} from '../../../redis/redis-lock.service';
import {
  ContactDailyMetricsDocument,
  ContactDailyMetricsSchemaClass,
} from './contact-daily-metrics.schema';

/** Tenants processed per run. A cap, not a limit on correctness — see the cron. */
const TENANT_BATCH = 200;

/**
 * Builds `contact_daily_metrics`.
 *
 * One aggregation per tenant per day, grouped by `(owner, orgUnit)`, upserted into a
 * unique bucket key so a re-run recomputes rather than doubles. That idempotence is
 * the point: a rollup job that cannot safely be repeated cannot be recovered after a
 * partial failure, and the corruption would be invisible.
 *
 * Runs at 04:00, after the retention purge at 03:00 — purged contacts should not
 * appear in a bucket computed minutes earlier and then vanish from the next one.
 */
@Injectable()
export class ContactMetricsRollupService {
  private readonly logger = new Logger(ContactMetricsRollupService.name);

  constructor(
    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<any>,
    @InjectModel(ContactDailyMetricsSchemaClass.name)
    private readonly metricsModel: Model<ContactDailyMetricsDocument>,
    private readonly lockService: RedisLockService,
  ) {}

  /**
   * Cluster-singleton, like the other crons: `@Cron` fires in every process that
   * loaded ScheduleModule, and N replicas computing the same buckets concurrently
   * would each issue the same upserts.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async runNightlyRollup(): Promise<void> {
    await this.lockService
      .acquire(
        'cron:contacts:daily-metrics-rollup',
        { ttl: 30 * 60 * 1000, maxRetries: 0 },
        async () => {
          // Yesterday, in the rollup timezone: today is still accumulating, and a
          // bucket for a partial day would be wrong until it was recomputed.
          const day = this.previousDay();
          const result = await this.rollupDay(day);
          this.logger.log(
            `Contact metrics rollup for ${day}: ${result.buckets} bucket(s) across ` +
              `${result.tenants} tenant(s)`,
          );
        },
      )
      .catch((err) => {
        // Contention is the normal case — N replicas tick, one wins — but a job that
        // THREW must not be reported as "skipped" at debug level. That conflation is
        // how four nightly jobs stayed dead for as long as they did.
        if (isLockContention(err)) {
          this.logger.debug(
            `Contact metrics rollup skipped: another replica holds the lock`,
          );
        } else {
          this.logger.error(
            `Contact metrics rollup FAILED: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      });
  }

  /**
   * Compute every tenant's buckets for one `YYYY-MM-DD`.
   * Public so the backfill script and a test can drive a single day.
   */
  async rollupDay(day: string): Promise<{ tenants: number; buckets: number }> {
    const timezone = this.timezone();
    const { from, to } = this.dayBounds(day, timezone);

    // Which tenants had any activity that day. Deriving this from the data rather
    // than from the tenants collection means a tenant with no contacts costs
    // nothing, and a deleted tenant stops appearing on its own.
    // `distinct` is a hooked operation too, and this one is the rollup's FIRST query:
    // it asks which tenants had activity, so it is cross-tenant by definition and can
    // never carry a tenant predicate. Unmarked, the whole nightly rollup died here
    // before reaching the aggregation below.
    const tenantIds: Types.ObjectId[] = await this.contactModel
      .distinct('tenantId', {
        $or: [
          { createdAt: { $gte: from, $lte: to } },
          { deletedAt: { $gte: from, $lte: to } },
        ],
      })
      .setOptions({ isPlatformQuery: true } as any);

    let buckets = 0;
    for (const tenantId of tenantIds.slice(0, TENANT_BATCH)) {
      buckets += await this.rollupTenantDay(tenantId, day, timezone, from, to);
    }

    if (tenantIds.length > TENANT_BATCH) {
      // Never silently truncate: a partial rollup that reports success is how the
      // read path ends up serving zeros for real days.
      this.logger.warn(
        `${tenantIds.length} tenants had activity on ${day} but only ${TENANT_BATCH} ` +
          'were rolled up. Raise TENANT_BATCH or shard the job.',
      );
    }

    return { tenants: Math.min(tenantIds.length, TENANT_BATCH), buckets };
  }

  /** Backfill a closed range, oldest first. Idempotent per day. */
  async backfill(
    fromDay: string,
    toDay: string,
  ): Promise<{ days: number; buckets: number }> {
    let buckets = 0;
    let days = 0;
    for (const day of this.daysBetween(fromDay, toDay)) {
      const result = await this.rollupDay(day);
      buckets += result.buckets;
      days++;
    }
    return { days, buckets };
  }

  private async rollupTenantDay(
    tenantId: Types.ObjectId,
    day: string,
    timezone: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    // `$facet` so one pass over the day's slice produces both series. The created
    // side deliberately carries no `deletedAt` predicate — it must match the live
    // query, which passes `skipSoftDelete` for this report. A "created" count that
    // shrinks when a record is later deleted is not a growth metric.
    const [result] = await this.contactModel
      .aggregate([
        {
          $match: {
            tenantId,
            $or: [
              { createdAt: { $gte: from, $lte: to } },
              { deletedAt: { $gte: from, $lte: to } },
            ],
          },
        },
        {
          $facet: {
            created: [
              { $match: { createdAt: { $gte: from, $lte: to } } },
              {
                $group: {
                  _id: { ownerId: '$ownerId', orgUnitId: '$orgUnitId' },
                  count: { $sum: 1 },
                },
              },
            ],
            deleted: [
              { $match: { deletedAt: { $gte: from, $lte: to } } },
              {
                $group: {
                  _id: { ownerId: '$ownerId', orgUnitId: '$orgUnitId' },
                  count: { $sum: 1 },
                },
              },
            ],
          },
        },
      ])
      .allowDiskUse(true)
      // Cross-tenant by construction: the pipeline's own `$match` names the tenant, and
      // the 04:00 cron has no request context for the plugin to read. Unmarked, the
      // plugin threw on the FIRST tenant and the rollup produced nothing — invisible,
      // because `canServeFromRollup` fails closed and every report quietly fell back to
      // the live query it was built to replace.
      .option({ isPlatformQuery: true } as any)
      .option({ maxTimeMS: 5 * 60 * 1000 })
      .read('secondaryPreferred')
      .exec();

    const merged = new Map<
      string,
      {
        ownerId: Types.ObjectId | null;
        orgUnitId: Types.ObjectId | null;
        created: number;
        deleted: number;
      }
    >();

    const accumulate = (rows: any[], field: 'created' | 'deleted') => {
      for (const row of rows ?? []) {
        const ownerId = row._id?.ownerId ?? null;
        const orgUnitId = row._id?.orgUnitId ?? null;
        const key = `${String(ownerId)}|${String(orgUnitId)}`;
        const entry = merged.get(key) ?? {
          ownerId,
          orgUnitId,
          created: 0,
          deleted: 0,
        };
        entry[field] = row.count ?? 0;
        merged.set(key, entry);
      }
    };
    accumulate(result?.created, 'created');
    accumulate(result?.deleted, 'deleted');

    if (merged.size === 0) return 0;

    const computedAt = new Date();
    await this.metricsModel.bulkWrite(
      Array.from(merged.values()).map((entry) => ({
        updateOne: {
          filter: {
            tenantId,
            day,
            timezone,
            ownerId: entry.ownerId,
            orgUnitId: entry.orgUnitId,
          },
          // `$set`, not `$inc`: the bucket is the computed truth for that day, so a
          // re-run must overwrite it. `$inc` would double every repeat.
          update: {
            $set: {
              created: entry.created,
              deleted: entry.deleted,
              computedAt,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    return merged.size;
  }

  // ── Date helpers ────────────────────────────────────────────────────────
  //
  // Day boundaries are computed in the rollup timezone, and that timezone is stored
  // on every row. A bucket built in one zone cannot serve a request in another: a
  // contact created at 23:30 UTC lands on a different day in Asia/Ho_Chi_Minh, and
  // the resulting totals still look plausible while being attributed to the wrong
  // days. The reader requires an exact timezone match rather than converting.

  private timezone(): string {
    return process.env.REPORT_ROLLUP_TIMEZONE?.trim() || 'UTC';
  }

  /** UTC instants bounding `day` as seen from `timezone`. */
  private dayBounds(day: string, timezone: string): { from: Date; to: Date } {
    const startUtc = new Date(`${day}T00:00:00Z`);
    // Offset of the zone at that moment, derived rather than hard-coded so DST is
    // handled without a table.
    const offsetMs = this.zoneOffsetMs(startUtc, timezone);
    const from = new Date(startUtc.getTime() - offsetMs);
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1);
    return { from, to };
  }

  private zoneOffsetMs(at: Date, timezone: string): number {
    if (timezone === 'UTC') return 0;
    try {
      // Format the same instant in the target zone, read it back as if UTC, and the
      // difference is the offset. Uses only Intl, so no tz database dependency.
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).formatToParts(at);
      const get = (type: string) =>
        Number(parts.find((p) => p.type === type)?.value ?? '0');
      const asUtc = Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour') % 24,
        get('minute'),
        get('second'),
      );
      return asUtc - at.getTime();
    } catch {
      this.logger.warn(
        `Unknown REPORT_ROLLUP_TIMEZONE "${timezone}"; treating buckets as UTC.`,
      );
      return 0;
    }
  }

  private previousDay(): string {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return yesterday.toISOString().slice(0, 10);
  }

  private daysBetween(fromDay: string, toDay: string): string[] {
    const days: string[] = [];
    let cursor = new Date(`${fromDay}T00:00:00Z`);
    const end = new Date(`${toDay}T00:00:00Z`);
    while (cursor <= end && days.length < 3650) {
      days.push(cursor.toISOString().slice(0, 10));
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    return days;
  }
}
