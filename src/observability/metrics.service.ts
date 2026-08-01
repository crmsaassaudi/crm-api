import { Injectable, Logger } from '@nestjs/common';

type HttpMetric = {
  count: number;
  durationSecondsSum: number;
  durationSecondsMax: number;
};

type GaugeMap = Map<string, number>;
type CounterMap = Map<string, number>;

/**
 * One observed distribution: cumulative bucket counts plus sum and count.
 *
 * A plain counter of "total milliseconds" can only ever yield a mean, and a
 * mean hides exactly the thing a latency SLO is written about — the tail. Every
 * decision that reads "act when p95 exceeds X" needs buckets, so the buckets
 * have to exist before the decision is due.
 */
type HistogramMetric = {
  /** The boundaries this series was created with; frozen for its lifetime. */
  buckets: readonly number[];
  bucketCounts: number[];
  sum: number;
  count: number;
};

/**
 * Millisecond boundaries, upper-inclusive. Chosen to straddle the values that
 * change a decision: the ~200 ms a healthy search returns in, the 800 ms at
 * which a list view stops feeling instant, and the multi-second range that
 * means something is wrong rather than slow.
 */
export const DEFAULT_MS_BUCKETS = [
  10, 25, 50, 100, 200, 400, 800, 1_600, 3_200,
] as const;

/**
 * Hard cap on distinct label tuples we track in memory. Without this, a single
 * caller that sends thousands of unique paths (e.g. routes with raw IDs that
 * slipped past normalizeRoute, or a probe walking the URL space) can grow this
 * Map unbounded and OOM the process. Far above the realistic route × status
 * cardinality of a well-behaved app.
 */
const MAX_METRIC_CARDINALITY = 5_000;

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly httpMetrics = new Map<string, HttpMetric>();
  /**
   * Free-form gauges (e.g. queue depth, lock contention). Keyed by
   * "metricName|JSON(labels)".
   */
  private readonly gauges: GaugeMap = new Map();
  /** Free-form counters (e.g. dlq.recorded, automation.rule.fired). */
  private readonly counters: CounterMap = new Map();
  /** Free-form histograms (e.g. search latency). Same key scheme as counters. */
  private readonly histograms = new Map<string, HistogramMetric>();
  private overflowWarned = false;

  setGauge(
    metricName: string,
    labels: Record<string, string>,
    value: number,
  ): void {
    this.gauges.set(this.composeKey(metricName, labels), value);
  }

  incrementCounter(
    metricName: string,
    labels: Record<string, string>,
    by = 1,
  ): void {
    const key = this.composeKey(metricName, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  /**
   * Record one observation. `buckets` must be ascending and identical for every
   * observation of the same metric name — Prometheus cannot merge series whose
   * bucket boundaries differ, and a silently-changed boundary makes the
   * histogram unreadable across a deploy.
   */
  observeHistogram(
    metricName: string,
    labels: Record<string, string>,
    value: number,
    buckets: readonly number[] = DEFAULT_MS_BUCKETS,
  ): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = this.composeKey(metricName, labels);
    let metric = this.histograms.get(key);
    if (!metric) {
      if (this.histograms.size >= MAX_METRIC_CARDINALITY) {
        this.warnCardinality();
        return;
      }
      metric = {
        buckets,
        bucketCounts: new Array(buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.histograms.set(key, metric);
    }
    // Cumulative on write: bucket i counts everything ≤ buckets[i], which is
    // the representation Prometheus expects and avoids a second pass on scrape.
    // Uses the series' own boundaries, not the caller's, so a changed argument
    // cannot corrupt a series that is already being scraped.
    const boundaries = metric.buckets;
    for (let index = 0; index < boundaries.length; index += 1) {
      if (value <= boundaries[index]) metric.bucketCounts[index] += 1;
    }
    metric.sum += value;
    metric.count += 1;
  }

  private composeKey(
    metricName: string,
    labels: Record<string, string>,
  ): string {
    return `${metricName}|${JSON.stringify(labels)}`;
  }

  private warnCardinality(): void {
    if (this.overflowWarned) return;
    this.logger.warn(
      `MetricsService cardinality cap hit (${MAX_METRIC_CARDINALITY}); ` +
        'further unique labels will be dropped. Likely cause: a route ' +
        'parameter or an unbounded label value.',
    );
    this.overflowWarned = true;
  }

  recordHttpRequest(params: {
    method: string;
    route: string;
    statusCode: number;
    durationSeconds: number;
  }): void {
    const labels = {
      method: params.method.toUpperCase(),
      route: this.normalizeRoute(params.route),
      status: String(params.statusCode),
    };
    const key = JSON.stringify(labels);
    const existing = this.httpMetrics.get(key);

    if (!existing && this.httpMetrics.size >= MAX_METRIC_CARDINALITY) {
      if (!this.overflowWarned) {
        this.logger.warn(
          `MetricsService cardinality cap hit (${MAX_METRIC_CARDINALITY}); ` +
            'further unique labels will be dropped. Likely cause: a route ' +
            'parameter that did not get normalized.',
        );
        this.overflowWarned = true;
      }
      // Drop this sample rather than admit a new key. Existing keys still
      // continue to accumulate accurately.
      return;
    }

    const metric = existing ?? {
      count: 0,
      durationSecondsSum: 0,
      durationSecondsMax: 0,
    };

    metric.count += 1;
    metric.durationSecondsSum += params.durationSeconds;
    metric.durationSecondsMax = Math.max(
      metric.durationSecondsMax,
      params.durationSeconds,
    );

    this.httpMetrics.set(key, metric);
  }

  toPrometheus(): string {
    const lines = [
      '# HELP crm_http_requests_total Total HTTP requests observed by the API process.',
      '# TYPE crm_http_requests_total counter',
    ];

    for (const [labelJson, metric] of this.httpMetrics.entries()) {
      lines.push(
        `crm_http_requests_total${this.formatLabels(labelJson)} ${metric.count}`,
      );
    }

    lines.push(
      '# HELP crm_http_request_duration_seconds_sum Total HTTP request duration in seconds.',
      '# TYPE crm_http_request_duration_seconds_sum counter',
    );
    for (const [labelJson, metric] of this.httpMetrics.entries()) {
      lines.push(
        `crm_http_request_duration_seconds_sum${this.formatLabels(labelJson)} ${metric.durationSecondsSum.toFixed(6)}`,
      );
    }

    lines.push(
      '# HELP crm_http_request_duration_seconds_max Max HTTP request duration in seconds since process start.',
      '# TYPE crm_http_request_duration_seconds_max gauge',
    );
    for (const [labelJson, metric] of this.httpMetrics.entries()) {
      lines.push(
        `crm_http_request_duration_seconds_max${this.formatLabels(labelJson)} ${metric.durationSecondsMax.toFixed(6)}`,
      );
    }

    // Append custom gauges and counters
    const gaugesByName = this.groupByName(this.gauges);
    for (const [name, entries] of gaugesByName.entries()) {
      lines.push(`# TYPE ${name} gauge`);
      for (const [labelJson, value] of entries) {
        lines.push(`${name}${this.formatLabels(labelJson)} ${value}`);
      }
    }
    const countersByName = this.groupByName(this.counters);
    for (const [name, entries] of countersByName.entries()) {
      lines.push(`# TYPE ${name} counter`);
      for (const [labelJson, value] of entries) {
        lines.push(`${name}${this.formatLabels(labelJson)} ${value}`);
      }
    }

    for (const [name, entries] of this.groupHistogramsByName().entries()) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [labelJson, metric] of entries) {
        for (let index = 0; index < metric.buckets.length; index += 1) {
          lines.push(
            `${name}_bucket${this.formatLabels(labelJson, {
              le: String(metric.buckets[index]),
            })} ${metric.bucketCounts[index]}`,
          );
        }
        // The +Inf bucket is mandatory and must equal _count, otherwise
        // histogram_quantile() silently returns NaN.
        lines.push(
          `${name}_bucket${this.formatLabels(labelJson, { le: '+Inf' })} ${metric.count}`,
        );
        lines.push(
          `${name}_sum${this.formatLabels(labelJson)} ${metric.sum.toFixed(3)}`,
        );
        lines.push(
          `${name}_count${this.formatLabels(labelJson)} ${metric.count}`,
        );
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  private groupHistogramsByName(): Map<
    string,
    Array<[string, HistogramMetric]>
  > {
    const result = new Map<string, Array<[string, HistogramMetric]>>();
    for (const [composite, metric] of this.histograms.entries()) {
      const sep = composite.indexOf('|');
      if (sep < 0) continue;
      const name = composite.slice(0, sep);
      const bucket = result.get(name) ?? [];
      bucket.push([composite.slice(sep + 1), metric]);
      result.set(name, bucket);
    }
    return result;
  }

  private groupByName(
    map: Map<string, number>,
  ): Map<string, Array<[string, number]>> {
    const result = new Map<string, Array<[string, number]>>();
    for (const [composite, value] of map.entries()) {
      const sep = composite.indexOf('|');
      if (sep < 0) continue;
      const name = composite.slice(0, sep);
      const labelJson = composite.slice(sep + 1);
      const bucket = result.get(name) ?? [];
      bucket.push([labelJson, value]);
      result.set(name, bucket);
    }
    return result;
  }

  private normalizeRoute(route: string): string {
    return route.replace(/\/+/g, '/') || 'unknown';
  }

  private formatLabels(
    labelJson: string,
    extra?: Record<string, string>,
  ): string {
    const labels = {
      ...(JSON.parse(labelJson) as Record<string, string>),
      ...extra,
    };
    return `{${Object.entries(labels)
      .map(([key, value]) => `${key}="${this.escapeLabel(value)}"`)
      .join(',')}}`;
  }

  private escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
}
