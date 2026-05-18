import { Injectable } from '@nestjs/common';

type HttpMetric = {
  count: number;
  durationSecondsSum: number;
  durationSecondsMax: number;
};

@Injectable()
export class MetricsService {
  private readonly httpMetrics = new Map<string, HttpMetric>();

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
    const metric = this.httpMetrics.get(key) ?? {
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

    lines.push('');
    return lines.join('\n');
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
