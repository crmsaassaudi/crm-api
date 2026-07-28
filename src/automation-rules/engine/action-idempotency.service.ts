import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { AutomationActionJobData } from '../queue/automation-queue.constants';

/**
 * Exactly-once execution for automation action jobs.
 *
 * The engine's previous guarantee was a deterministic BullMQ `jobId`
 * (`${executionId}:${nodeId}`), which only rejects a duplicate while the job
 * record still exists in Redis. Retention is `removeOnComplete: {count: 200-500,
 * age: 24h}`, so at the volumes this engine is sized for the completed set turns
 * over in well under a second and the guard silently evaporates. Delivery into
 * the queue is at-least-once, and `send_email`, `create_task`, `create_ticket`
 * and `create_record` are not idempotent — a redelivered job sends a second
 * email or creates a second ticket.
 *
 * This moves the guarantee off queue retention and onto an explicit key with a
 * TTL we choose:
 *
 *   claim()  SET NX  → first worker wins and proceeds
 *   confirm()        → mark done; later duplicates are refused for TTL
 *   release()        → failed and retryable, so let the retry back in
 *
 * The claim is deliberately made BEFORE the action runs and released on a
 * retryable failure. Claiming without releasing would turn every transient
 * failure into a permanently skipped action; confirming before running would
 * lose the action if the worker died mid-flight.
 *
 * @see docs/audit/WORKFLOW_AUTOMATION_SECURITY_AUDIT.md — finding H6
 */
@Injectable()
export class ActionIdempotencyService {
  private readonly logger = new Logger(ActionIdempotencyService.name);

  /**
   * How long a completed action stays remembered. Must comfortably exceed the
   * window in which a redelivery is plausible (BullMQ stalled-job recovery plus
   * the retry backoff ladder), and is unrelated to queue retention.
   */
  private readonly TTL_SECONDS = 24 * 60 * 60;

  /** Marker for a claim that is in flight; `done` once the action succeeded. */
  private static readonly IN_FLIGHT = 'in-flight';
  private static readonly DONE = 'done';

  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Identity of one unit of work.
   *
   * (execution, node) rather than the job id: a manual retry, a stalled-job
   * redelivery and a duplicate dispatch are all *the same action on the same
   * record*, and all three should collapse. The retry endpoint clears the key
   * explicitly when an operator genuinely wants the action to run again.
   */
  buildKey(
    data: Pick<AutomationActionJobData, 'tenantId' | 'executionId' | 'nodeId'>,
  ): string {
    return `automation:idem:${data.tenantId}:${data.executionId}:${data.nodeId}`;
  }

  /**
   * Try to claim the action.
   *
   * @returns `true` when the caller owns the execution, `false` when it has
   *          already run (or is running elsewhere) and must be skipped.
   */
  async claim(data: AutomationActionJobData): Promise<boolean> {
    const key = this.buildKey(data);
    try {
      const acquired = await this.redis.set(
        key,
        ActionIdempotencyService.IN_FLIGHT,
        'EX',
        this.TTL_SECONDS,
        'NX',
      );
      if (acquired === 'OK') return true;

      const state = await this.redis.get(key);
      this.logger.warn(
        `[Idempotency] Skipping duplicate action ${data.actionType} for ` +
          `execution=${data.executionId} node=${data.nodeId} (state=${state ?? 'unknown'})`,
      );
      return false;
    } catch (err: any) {
      // Fail closed at the side-effect boundary. BullMQ will retry after Redis
      // recovers; running now could send or create the same thing twice.
      this.logger.error(
        `[Idempotency] Redis error claiming ${key} — refusing unsafe ` +
          `execution: ${err.message}`,
      );
      throw new Error(
        `IDEMPOTENCY_UNAVAILABLE: cannot safely claim action ${data.executionId}/${data.nodeId}`,
      );
    }
  }

  /** Mark the action as done so later redeliveries are refused for the TTL. */
  async confirm(data: AutomationActionJobData): Promise<void> {
    const key = this.buildKey(data);
    await this.redis
      .set(key, ActionIdempotencyService.DONE, 'EX', this.TTL_SECONDS)
      .catch((err: any) =>
        this.logger.warn(
          `[Idempotency] Failed to confirm ${key}: ${err.message}`,
        ),
      );
  }

  /**
   * Drop the claim so a retry can run.
   *
   * Called when the action failed in a way BullMQ will retry. Without this the
   * first transient failure would consume the only claim and every retry would
   * be skipped as a "duplicate" — an outage that looks like success.
   */
  async release(data: AutomationActionJobData): Promise<void> {
    const key = this.buildKey(data);
    await this.redis
      .del(key)
      .catch((err: any) =>
        this.logger.warn(
          `[Idempotency] Failed to release ${key}: ${err.message}`,
        ),
      );
  }
}
