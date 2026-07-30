import { Aggregate, Model } from 'mongoose';

/**
 * Default cap on how long a report aggregation may run before Mongo kills it.
 * A report that has not answered in 20s will not be waited for by a browser
 * either, and letting it run on is how one expensive filter starves the pool.
 */
const DEFAULT_MAX_TIME_MS = 20_000;

/**
 * Run a report aggregation with the options every report needs and none of them
 * had.
 *
 * Reports aggregate live over the OLTP collections — the contact funnel `$unwind`s
 * an unbounded `stageHistory` array across an entire tenant — with no
 * `allowDiskUse`, no read preference and no time limit. At scale that is three
 * separate ways for one report request to hurt everything else:
 *
 *   - **allowDiskUse**: a `$group`/`$sort` whose working set passes 100MB fails
 *     outright with `QueryExceededMemoryLimit`. The report does not degrade, it
 *     errors — and it errors first for the biggest tenant, i.e. the one most
 *     likely to be looking.
 *   - **readPreference**: without it every scan lands on the primary, competing
 *     with the writes that serve the actual application. `secondaryPreferred`
 *     moves it to a replica while still working on a single-node deployment,
 *     which `secondary` would not.
 *   - **maxTimeMS**: an unbounded pipeline holds its slot until it finishes.
 *
 * Reading from a secondary means a report can lag the primary by the replication
 * delay — typically milliseconds, and reports are historical by nature. Where
 * that is not acceptable, pass `readPreference: 'primary'` explicitly so the
 * choice is visible at the call site rather than implied by its absence.
 *
 * Set `REPORT_READ_PREFERENCE=primary` to force every report back onto the
 * primary without a code change (single-node deployments, or a replica set with
 * unhealthy secondaries).
 */
export interface ReportAggregateOptions {
  /** Overrides the env default. Use 'primary' when staleness is unacceptable. */
  readPreference?: 'primary' | 'primaryPreferred' | 'secondaryPreferred';
  maxTimeMS?: number;
  /** Disable disk spill for a pipeline known to be tiny. Rarely useful. */
  allowDiskUse?: boolean;
}

export function reportAggregate<T = any>(
  model: Model<any>,
  pipeline: any[],
  options: ReportAggregateOptions = {},
): Aggregate<T[]> {
  const aggregate = model.aggregate<T>(pipeline);

  aggregate.allowDiskUse(options.allowDiskUse ?? true);
  aggregate.option({ maxTimeMS: options.maxTimeMS ?? DEFAULT_MAX_TIME_MS });
  aggregate.read(
    (options.readPreference ?? resolveDefaultReadPreference()) as any,
  );

  return aggregate;
}

/**
 * Apply the same options to a plain `countDocuments` / `find` query used by a
 * report. Counts scan too, and a report's count is as capable of stalling the
 * primary as its pipeline.
 */
export function applyReportQueryOptions<
  TQuery extends {
    maxTimeMS(ms: number): TQuery;
    read(pref: any): TQuery;
  },
>(query: TQuery, options: ReportAggregateOptions = {}): TQuery {
  query.maxTimeMS(options.maxTimeMS ?? DEFAULT_MAX_TIME_MS);
  query.read(options.readPreference ?? resolveDefaultReadPreference());
  return query;
}

function resolveDefaultReadPreference(): string {
  const configured = process.env.REPORT_READ_PREFERENCE;
  return configured && configured.trim().length > 0
    ? configured.trim()
    : 'secondaryPreferred';
}
