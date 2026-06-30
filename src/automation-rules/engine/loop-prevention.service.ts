import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';

/**
 * LoopPreventionService — 3-layer defense against infinite automation loops.
 *
 * Layer 1: Strict Loop Detection
 *   → Same record visiting same node > 3 times within 5s execution session
 *   → Detects self-triggering workflows (A → update field → triggers A again)
 *
 * Layer 2: Cross-Automation Depth Limit
 *   → Chains of WF_A → WF_B → WF_C → ... exceeding 5 levels
 *   → Detects cascading automation chains
 *
 * Layer 3: Run Once Per Record
 *   → User-configured flag: "Only run once per record"
 *   → Redis SET with 24h TTL per (workflow, record) pair
 *
 * @see docs/prd-visual-automation-builder.md — Task 1.5
 */
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

  // ── Layer 1: Strict Loop Detection (5s window) ───────────────────────

  /**
   * Check if a record has passed through a specific node too many times
   * within the current execution session.
   *
   * @returns { allowed: true } if the execution can proceed,
   *          { allowed: false, reason } if loop detected
   */
  async checkStrictLoop(params: {
    tenantId: string;
    executionSessionId: string;
    nodeId: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const key = `automation:loop:${params.tenantId}:${params.executionSessionId}:${params.nodeId}`;

    // Atomic incr + expire: a plain INCR followed by a conditional EXPIRE has a
    // race window where two concurrent workers both see count > 1 and neither
    // sets the TTL, leaking the key forever.
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

  // ── Layer 2: Cross-Automation Depth Limit ────────────────────────────

  /**
   * Check if the automation chain depth has exceeded the maximum.
   * Depth is propagated through event payloads from one workflow to the next.
   *
   * @param depth - Current depth counter (starts at 0 for user-initiated events)
   * @returns { allowed: true } if within limits
   */
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

  /**
   * Block if a workflow appears twice in the same automation chain.
   * Breadcrumbs travel in queue payloads, so this works across workers.
   */
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

  // ── Layer 3: Run Once Per Record ─────────────────────────────────────

  /**
   * Check if a workflow has already been executed for a specific record.
   * Only applies when the workflow has `runOncePerRecord = true`.
   *
   * @returns { allowed: true } if the workflow can run,
   *          { allowed: false, reason } if already executed for this record
   */
  /**
   * Atomic check-and-mark for run-once semantics.
   * Uses SET NX (set-if-not-exists) to eliminate the TOCTOU race between
   * separate checkRunOnce() and markRunOnce() calls.
   *
   * @returns { allowed: true } if this is the first execution,
   *          { allowed: false, reason } if already executed for this record
   */
  async checkAndMarkRunOnce(params: {
    tenantId: string;
    workflowId: string;
    recordId: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const key = `automation:runonce:${params.tenantId}:${params.workflowId}:${params.recordId}`;

    // SET NX: returns 'OK' if the key was set (first execution),
    // null if the key already exists (already executed).
    const result = await this.redis.set(key, '1', 'EX', this.RUN_ONCE_TTL, 'NX');

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

  // ── Cleanup (for testing) ────────────────────────────────────────────

  /**
   * Clear all loop prevention keys for a tenant.
   * Used in integration tests only.
   *
   * MED-05: refuses to run in production (KEYS/SCAN over a shared keyspace is a
   * footgun there) and uses a non-blocking SCAN cursor instead of the
   * O(N)-blocking KEYS command.
   */
  async clearTenantKeys(tenantId: string): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'clearTenantKeys() is a test-only helper and must not run in production',
      );
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
