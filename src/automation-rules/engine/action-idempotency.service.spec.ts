import { ActionIdempotencyService } from './action-idempotency.service';
import { AutomationActionJobData } from '../queue/automation-queue.constants';

const job = {
  tenantId: 't1',
  executionId: 'exec1',
  nodeId: 'n1',
  actionType: 'send_email',
} as AutomationActionJobData;

/**
 * The engine's previous exactly-once guarantee was a deterministic BullMQ jobId,
 * which only dedupes while the completed job is still in Redis — a window of
 * seconds at this engine's volumes. A redelivered send_email is a second email.
 */
describe('ActionIdempotencyService', () => {
  const buildRedis = () => ({
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
  });

  it('should key on (tenant, execution, node), not on the job id', () => {
    const redis = buildRedis();
    const service = new ActionIdempotencyService(redis as any);

    // A manual retry, a stalled-job redelivery and a duplicate dispatch are the
    // same action on the same record, so all three must collapse.
    expect(service.buildKey(job)).toBe('automation:idem:t1:exec1:n1');
  });

  it('should claim with SET NX and an explicit TTL', async () => {
    const redis = buildRedis();
    const service = new ActionIdempotencyService(redis as any);

    await expect(service.claim(job)).resolves.toBe(true);

    expect(redis.set).toHaveBeenCalledWith(
      'automation:idem:t1:exec1:n1',
      'in-flight',
      'EX',
      86400,
      'NX',
    );
  });

  it('should refuse a second claim for the same action', async () => {
    const redis = buildRedis();
    redis.set.mockResolvedValue(null); // NX lost
    redis.get.mockResolvedValue('done');
    const service = new ActionIdempotencyService(redis as any);

    await expect(service.claim(job)).resolves.toBe(false);
  });

  it('should fail closed when Redis is unavailable', async () => {
    const redis = buildRedis();
    redis.set.mockRejectedValue(new Error('redis offline'));
    const service = new ActionIdempotencyService(redis as any);

    // Losing Redis must not stop automations; the guard is simply unavailable,
    // which is no worse than the previous state of having none.
    await expect(service.claim(job)).rejects.toThrow(/IDEMPOTENCY_UNAVAILABLE/);
  });

  it('should mark the action done on confirm', async () => {
    const redis = buildRedis();
    const service = new ActionIdempotencyService(redis as any);

    await service.confirm(job);

    expect(redis.set).toHaveBeenCalledWith(
      'automation:idem:t1:exec1:n1',
      'done',
      'EX',
      86400,
    );
  });

  it('should drop the claim on release so a retry can run', async () => {
    const redis = buildRedis();
    const service = new ActionIdempotencyService(redis as any);

    await service.release(job);

    expect(redis.del).toHaveBeenCalledWith('automation:idem:t1:exec1:n1');
  });

  it('should swallow a Redis failure on confirm and release', async () => {
    const redis = buildRedis();
    redis.set.mockRejectedValue(new Error('offline'));
    redis.del.mockRejectedValue(new Error('offline'));
    const service = new ActionIdempotencyService(redis as any);

    // Bookkeeping must never fail the job that already did its work.
    await expect(service.confirm(job)).resolves.toBeUndefined();
    await expect(service.release(job)).resolves.toBeUndefined();
  });
});
