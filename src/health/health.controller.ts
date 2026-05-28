import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { Public } from 'nest-keycloak-connect';

/**
 * Health Check controller for Kubernetes liveness/readiness probes.
 *
 * Exposed at GET /api/v1/health — bypasses all auth guards.
 * Returns basic service uptime and timestamp for monitoring dashboards.
 */
@Controller({ path: 'health', version: '1' })
@Public()
export class HealthController {
  private readonly startedAt = new Date();

  @Get()
  @HttpCode(HttpStatus.OK)
  check() {
    return {
      status: 'ok',
      uptime: Math.floor(
        (Date.now() - this.startedAt.getTime()) / 1000,
      ),
      timestamp: new Date().toISOString(),
    };
  }
}
