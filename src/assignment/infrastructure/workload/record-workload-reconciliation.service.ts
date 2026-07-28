import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { MetricsService } from '../../../observability/metrics.service';
import { IOREDIS_CLIENT } from '../../../redis/redis.tokens';
import { RecordLoadPort } from '../../adapters/record/record-load.port';
import {
  AssignmentObjectType,
  isAssignmentObjectType,
} from '../../domain/assignment.types';
import { ZsetReservationService } from '../reservation/zset-reservation.service';

const LOCK_KEY = 'assignment:workload:reconcile:lock';
const LOCK_TTL_SECONDS = 14 * 60;

@Injectable()
export class RecordWorkloadReconciliationService {
  private readonly logger = new Logger(
    RecordWorkloadReconciliationService.name,
  );

  constructor(
    private readonly reservation: ZsetReservationService,
    private readonly recordLoad: RecordLoadPort,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  @Cron('*/15 * * * *')
  async reconcileAllTrackedScopes(): Promise<void> {
    const token = `${process.pid}:${Date.now()}`;
    const acquired = await this.redis.set(
      LOCK_KEY,
      token,
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );
    if (!acquired) return;

    try {
      const scopes = await this.reservation.trackedLoadScopes();
      for (const rawScope of scopes) {
        const parsed = this.parseScope(rawScope);
        if (!parsed) continue;
        try {
          const result = await this.recordLoad.reconcileTrackedScope(parsed);
          const labels = { object_type: parsed.objectType };
          this.metrics?.setGauge(
            'crm_assignment_workload_drift_agents',
            labels,
            result.drifted,
          );
          this.metrics?.setGauge(
            'crm_assignment_workload_absolute_drift',
            labels,
            result.absoluteDrift,
          );
          if (result.drifted > 0) {
            this.metrics?.incrementCounter(
              'crm_assignment_workload_reconciliations_total',
              labels,
            );
            this.logger.warn(
              `[WorkloadReconcile] ${rawScope}: patched ${result.drifted}/${result.candidates} candidates (absolute drift ${result.absoluteDrift})`,
            );
          }
        } catch (err: any) {
          this.logger.error(
            `[WorkloadReconcile] Failed for ${rawScope}: ${err.message}`,
          );
        }
      }
    } finally {
      // Compare-and-delete so an expired lock acquired by another pod is never
      // removed by this run.
      await this.redis
        .eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
          1,
          LOCK_KEY,
          token,
        )
        .catch(() => undefined);
    }
  }

  private parseScope(
    raw: string,
  ): { tenantId: string; objectType: AssignmentObjectType } | null {
    const separator = raw.lastIndexOf(':');
    if (separator <= 0) return null;
    const tenantId = raw.slice(0, separator);
    const objectType = raw.slice(separator + 1);
    if (!tenantId || !isAssignmentObjectType(objectType)) return null;
    if (objectType === 'Conversation') return null;
    return { tenantId, objectType };
  }
}
