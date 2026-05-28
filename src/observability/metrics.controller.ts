import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Unprotected } from 'nest-keycloak-connect';
import { MetricsService } from './metrics.service';
import type { Request } from 'express';

const DEFAULT_ALLOWED_CIDRS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

@Controller({ path: 'metrics', version: '1' })
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @Unprotected()
  @SkipThrottle()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(@Req() req: Request): string {
    // /metrics must NOT be public — it can leak internal route shape, error
    // counts and tenant cardinality. Allow only localhost (Prometheus
    // sidecar) and any IPs listed in METRICS_ALLOW_IPS.
    if (!this.isAllowed(req)) {
      throw new ForbiddenException('metrics endpoint is not public');
    }
    return this.metricsService.toPrometheus() + this.processMetrics();
  }

  private isAllowed(req: Request): boolean {
    const allowed = new Set([
      ...DEFAULT_ALLOWED_CIDRS,
      ...(process.env.METRICS_ALLOW_IPS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ]);
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        ?.trim() ||
      req.ip ||
      req.socket.remoteAddress ||
      '';
    return allowed.has(ip);
  }

  /**
   * Node process metrics in Prometheus exposition format. Cheap to compute
   * on each scrape; gives ops a baseline view (memory/CPU/uptime) without
   * pulling in `prom-client` as a dependency.
   */
  private processMetrics(): string {
    const mem = process.memoryUsage();
    const uptime = process.uptime();
    const cpu = process.cpuUsage();
    return [
      '',
      '# HELP nodejs_process_resident_memory_bytes Resident memory in bytes.',
      '# TYPE nodejs_process_resident_memory_bytes gauge',
      `nodejs_process_resident_memory_bytes ${mem.rss}`,
      '# HELP nodejs_process_heap_used_bytes V8 heap used in bytes.',
      '# TYPE nodejs_process_heap_used_bytes gauge',
      `nodejs_process_heap_used_bytes ${mem.heapUsed}`,
      '# HELP nodejs_process_heap_total_bytes V8 heap total in bytes.',
      '# TYPE nodejs_process_heap_total_bytes gauge',
      `nodejs_process_heap_total_bytes ${mem.heapTotal}`,
      '# HELP nodejs_process_uptime_seconds Process uptime in seconds.',
      '# TYPE nodejs_process_uptime_seconds counter',
      `nodejs_process_uptime_seconds ${uptime}`,
      '# HELP nodejs_process_cpu_user_seconds_total Cumulative user CPU seconds.',
      '# TYPE nodejs_process_cpu_user_seconds_total counter',
      `nodejs_process_cpu_user_seconds_total ${cpu.user / 1_000_000}`,
      '# HELP nodejs_process_cpu_system_seconds_total Cumulative system CPU seconds.',
      '# TYPE nodejs_process_cpu_system_seconds_total counter',
      `nodejs_process_cpu_system_seconds_total ${cpu.system / 1_000_000}`,
      '',
    ].join('\n');
  }
}
