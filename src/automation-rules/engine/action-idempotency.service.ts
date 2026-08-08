import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { AutomationActionJobData } from '../queue/automation-queue.constants';

@Injectable()
export class ActionIdempotencyService {
  private readonly logger = new Logger(ActionIdempotencyService.name);

  private readonly TTL_SECONDS = 24 * 60 * 60;
  private static readonly IN_FLIGHT = 'in-flight';
  private static readonly DONE = 'done';

  constructor(@Inject(IOREDIS_CLIENT) private readonly redis: Redis) {}

  buildKey(
    data: Pick<AutomationActionJobData, 'tenantId' | 'executionId' | 'nodeId'>,
  ): string {
    return `automation:idem:${data.tenantId}:${data.executionId}:${data.nodeId}`;
  }
  
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
      this.logger.error(
        `[Idempotency] Redis error claiming ${key} — refusing unsafe ` +
          `execution: ${err.message}`,
      );
      throw new Error(
        `IDEMPOTENCY_UNAVAILABLE: cannot safely claim action ${data.executionId}/${data.nodeId}`,
      );
    }
  }

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
