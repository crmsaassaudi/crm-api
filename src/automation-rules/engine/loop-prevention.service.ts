import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

@Injectable()
export class LoopPreventionService {
  private readonly logger = new Logger(LoopPreventionService.name);

  /** Layer 1: Max passes through same node in one execution session */
  private readonly STRICT_THRESHOLD = 3;
  /** Layer 1: TTL for strict loop detection keys (seconds) */
  private readonly STRICT_TTL = 5;

  /** Layer 2: Max cross-automation chain depth. Depth 0-5 is allowed. */
  private readonly MAX_DEPTH = 5;

  /** Layer 3: TTL for run-once keys (seconds) — 24 hours */
  private readonly RUN_ONCE_TTL = 86400;

  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  async checkStrictLoop(params: {
    tenantId: string;
    executionSessionId: string;
    nodeId: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const key = `automation:loop:${params.tenantId}:${params.executionSessionId}:${params.nodeId}`;

    const incrWithTtlScript = `
      local count = redis.call('incr', KEYS[1])
      if count == 1 then
        redis.call('expire', KEYS[1], ARGV[1])
      end
      return count
    `;
    const count = (await this.redis.eval(
      incrWithTtlScript,
      1,
      key,
      String(this.STRICT_TTL),
    )) as number;

    if (count > this.STRICT_THRESHOLD) {
      this.logger.warn(
        `[Layer 1] LOOP_STRICT_DETECTED: node=${params.nodeId} session=${params.executionSessionId} count=${count}`,
      );
      return {
        allowed: false,
        reason: `Node ${params.nodeId} executed ${count} times in ${this.STRICT_TTL}s (threshold: ${this.STRICT_THRESHOLD})`,
      };
    }

    return { allowed: true };
  }

  checkDepthLimit(depth: number): {
    allowed: boolean;
    reason?: string;
  } {
    if (depth > this.MAX_DEPTH) {
      this.logger.warn(
        `[Layer 2] LOOP_DEPTH_EXCEEDED: depth=${depth} max=${this.MAX_DEPTH}`,
      );
      return {
        allowed: false,
        reason: `Automation chain depth ${depth} exceeds maximum of ${this.MAX_DEPTH}`,
      };
    }
    return { allowed: true };
  }

  checkBreadcrumbs(params: { workflowId: string; breadcrumbs?: string[] }): {
    allowed: boolean;
    reason?: string;
  } {
    const breadcrumbs = params.breadcrumbs ?? [];
    if (!breadcrumbs.includes(params.workflowId)) {
      return { allowed: true };
    }

    this.logger.warn(
      `[Layer 2] LOOP_BREADCRUMB_DETECTED: workflow=${params.workflowId} chain=${breadcrumbs.join('>')}`,
    );
    return {
      allowed: false,
      reason: `Workflow ${params.workflowId} already exists in automation chain`,
    };
  }

  async checkAndMarkRunOnce(params: {
    tenantId: string;
    workflowId: string;
    recordId: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const key = `automation:runonce:${params.tenantId}:${params.workflowId}:${params.recordId}`;

    // SET NX: returns 'OK' if the key was set (first execution),
    // null if the key already exists (already executed).
    const result = await this.redis.set(
      key,
      '1',
      'EX',
      this.RUN_ONCE_TTL,
      'NX',
    );

    if (result !== 'OK') {
      this.logger.debug(
        `[Layer 3] LOOP_RUN_ONCE_SKIPPED: workflow=${params.workflowId} record=${params.recordId}`,
      );
      return {
        allowed: false,
        reason: `Workflow ${params.workflowId} already executed for record ${params.recordId}`,
      };
    }

    return { allowed: true };
  }

  
  async clearTenantKeys(tenantId: string): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        `clearTenantKeys() is a test-only helper (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}). ` +
          'It deletes run-once and loop-guard keys, which are shared with any ' +
          'other environment using the same Redis instance.',
      );
    }
    if (!tenantId) {
      // A blank tenant makes the pattern `automation:loop:*` — every tenant.
      throw new Error('clearTenantKeys() requires an explicit tenantId');
    }

    const patterns = [
      `automation:loop:${tenantId}:*`,
      `automation:runonce:${tenantId}:*`,
    ];

    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );
        cursor = next;
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } while (cursor !== '0');
    }
  }
}
