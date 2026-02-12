import { Injectable } from '@nestjs/common';

export interface RequestLog {
  timestamp: Date;
  service: string;
  error: string;
  correlationId?: string;
}

export interface ResilienceMetric {
  total: number;
  success: number;
  failure: number;
  lastError?: string;
  lastUpdated?: Date;
}

@Injectable()
export class ResilienceMetricsService {
  private readonly metrics = new Map<string, ResilienceMetric>();
  private readonly lastErrors: RequestLog[] = [];
  private readonly MAX_LOGS = 100;

  private getMetric(service: string): ResilienceMetric {
    if (!this.metrics.has(service)) {
      this.metrics.set(service, { total: 0, success: 0, failure: 0 });
    }
    return this.metrics.get(service)!;
  }

  recordSuccess(service: string) {
    const metric = this.getMetric(service);
    metric.total++;
    metric.success++;
    metric.lastUpdated = new Date();
  }

  recordFailure(service: string, error?: string, correlationId?: string) {
    const metric = this.getMetric(service);
    metric.total++;
    metric.failure++;
    metric.lastError = error;
    metric.lastUpdated = new Date();

    this.lastErrors.unshift({
      timestamp: new Date(),
      service,
      error: error || 'Unknown Error',
      correlationId,
    });

    if (this.lastErrors.length > this.MAX_LOGS) {
      this.lastErrors.pop();
    }
  }

  getMetrics() {
    const result: Record<string, any> = {};
    this.metrics.forEach((value, key) => {
      result[key] = {
        ...value,
        errorRate:
          value.total > 0
            ? ((value.failure / value.total) * 100).toFixed(2) + '%'
            : '0%',
      };
    });
    return result;
  }

  getLogs() {
    return this.lastErrors;
  }
}
