import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  ContactDailyMetricsDocument,
  ContactDailyMetricsSchemaClass,
} from './contact-daily-metrics.schema';
import {
  canServeFromRollup,
  type RollupDecision,
  type RollupRequestShape,
} from './can-serve-from-rollup';

export interface GrowthBucketRow {
  /** `YYYY-MM-DD` (day), `YYYY-WW` (week) or `YYYY-MM` (month) — matching the live shape. */
  _id: string;
  count: number;
}

export interface RollupGrowthResult {
  created: GrowthBucketRow[];
  deleted: GrowthBucketRow[];
}

/**
 * Reads the growth trend from `contact_daily_metrics` when — and only when — the
 * pre-aggregated rows can answer the exact question asked.
 *
 * `tryRead` returns null rather than throwing or approximating: the caller falls back
 * to the live aggregation, which is always correct. Every refusal is logged with its
 * reason, so "the rollup is never being used" is diagnosable instead of just slow.
 */
@Injectable()
export class ContactGrowthRollupReader {
  private readonly logger = new Logger(ContactGrowthRollupReader.name);

  constructor(
    @InjectModel(ContactDailyMetricsSchemaClass.name)
    private readonly metricsModel: Model<ContactDailyMetricsDocument>,
    private readonly cls: ClsService,
  ) {}

  private get timezone(): string {
    return process.env.REPORT_ROLLUP_TIMEZONE?.trim() || 'UTC';
  }

  private get enabled(): boolean {
    // Opt-OUT rather than opt-in, but only after a backfill exists: with no rows the
    // freshness check refuses everything anyway, so an un-backfilled deployment
    // silently keeps using the live query rather than reporting zeros.
    return process.env.REPORT_ROLLUP_ENABLED !== 'false';
  }

  /**
   * @returns the pre-aggregated buckets, or null when the caller must use the live
   *          aggregation.
   */
  async tryRead(params: {
    tenantId: Types.ObjectId | string;
    request: RollupRequestShape;
    from: Date;
    to: Date;
    timezone: string;
    granularity: 'day' | 'week' | 'month';
  }): Promise<RollupGrowthResult | null> {
    // A rollup bucketed in one zone cannot serve a request in another — the totals
    // would look right and be attributed to the wrong days.
    if (params.timezone !== this.timezone) {
      this.logger.debug(
        `Rollup skipped: request timezone ${params.timezone} != rollup timezone ${this.timezone}`,
      );
      return null;
    }

    const decision = await this.decide(
      params.tenantId,
      params.request,
      params.to,
    );
    if (!decision.canServe) {
      this.logger.debug(`Rollup skipped: ${decision.reason}`);
      return null;
    }

    const rows = await this.metricsModel
      .aggregate([
        {
          $match: {
            tenantId: toObjectId(params.tenantId),
            timezone: this.timezone,
            day: {
              $gte: toDayString(params.from),
              $lte: toDayString(params.to),
            },
            // Visibility applied to the DIMENSIONS. Each contact contributes to
            // exactly one (owner, orgUnit) bucket, so this yields the same answer as
            // the equivalent predicate on the contacts collection.
            ...this.visibilityMatch(),
          },
        },
        {
          $group: {
            _id: this.bucketExpression(params.granularity),
            created: { $sum: '$created' },
            deleted: { $sum: '$deleted' },
          },
        },
      ])
      .read('secondaryPreferred')
      .option({ maxTimeMS: 20_000 })
      .exec();

    return {
      // The live shape omits empty buckets and the caller fills gaps, so drop zeros
      // here too rather than emitting rows the live path never would.
      created: rows
        .filter((r: any) => r.created > 0)
        .map((r: any) => ({ _id: r._id, count: r.created })),
      deleted: rows
        .filter((r: any) => r.deleted > 0)
        .map((r: any) => ({ _id: r._id, count: r.deleted })),
    };
  }

  private async decide(
    tenantId: Types.ObjectId | string,
    request: RollupRequestShape,
    to: Date,
  ): Promise<RollupDecision> {
    const latest = await this.metricsModel
      .findOne(
        { tenantId: toObjectId(tenantId), timezone: this.timezone },
        { day: 1 },
      )
      .sort({ day: -1 })
      .lean()
      .exec();

    const abac = this.cls.get<{ resource?: string; filter?: unknown }>(
      'abacResourceFilter',
    );

    return canServeFromRollup(request, {
      visibleOwnerIds: this.cls.get('visibleOwnerIds'),
      hasAbacFilter: Boolean(abac?.filter),
      rollupCoveredThrough: (latest as any)?.day ?? null,
      requestedThrough: toDayString(to),
      enabled: this.enabled,
    });
  }

  /**
   * The same owner ∪ orgUnit union the repositories and the live report apply,
   * expressed over the rollup's dimensions.
   */
  private visibilityMatch(): Record<string, unknown> {
    const visibleOwnerIds = this.cls.get('visibleOwnerIds');
    if (!Array.isArray(visibleOwnerIds)) return {};

    const clauses: Record<string, unknown>[] = [
      { ownerId: { $in: visibleOwnerIds.map(toObjectId) } },
    ];
    if (this.cls.get('includeUnownedInScope') === true) {
      clauses.push({ ownerId: null });
    }
    const orgUnitIds = this.cls.get('visibleOrgUnitIds');
    if (Array.isArray(orgUnitIds) && orgUnitIds.length > 0) {
      clauses.push({ orgUnitId: { $in: orgUnitIds.map(toObjectId) } });
    }
    return { $or: clauses };
  }

  /**
   * Group day strings up to the requested granularity.
   *
   * Week and month boundaries align with day boundaries in the same timezone, so
   * summing days is exact — which is the reason the rollup is stored per-day rather
   * than per-granularity.
   */
  private bucketExpression(granularity: 'day' | 'week' | 'month'): unknown {
    if (granularity === 'day') return '$day';
    if (granularity === 'month') return { $substrBytes: ['$day', 0, 7] };
    return {
      $dateToString: {
        format: '%G-%V',
        date: { $dateFromString: { dateString: '$day' } },
      },
    };
  }
}

function toObjectId(value: unknown): any {
  const asString = String(value);
  return Types.ObjectId.isValid(asString)
    ? new Types.ObjectId(asString)
    : value;
}

/** UTC calendar date of an instant. Bounds are already zone-adjusted by the writer. */
function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
