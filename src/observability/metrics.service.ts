import { Injectable, Logger } from '@nestjs/common';

type HttpMetric = {
  count: number;
  durationSecondsSum: number;
  durationSecondsMax: number;
};

type GaugeMap = Map<string, number>;
type CounterMap = Map<string, number>;

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

  private composeKey(
    metricName: string,
    labels: Record<string, string>,
  ): string {
    return `${metricName}|${JSON.stringify(labels)}`;
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

    if (
      !existing &&
      this.httpMetrics.size >= MAX_METRIC_CARDINALITY
    ) {
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

    lines.push('');
    return lines.join('\n');
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

  private formatLabels(labelJson: string): string {
    const labels = JSON.parse(labelJson) as Record<string, string>;
    return `{${Object.entries(labels)
      .map(([key, value]) => `${key}="${this.escapeLabel(value)}"`)
      .join(',')}}`;
  }

  private escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
}
