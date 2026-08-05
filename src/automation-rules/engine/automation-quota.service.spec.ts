import { AutomationQuotaService } from './automation-quota.service';

/**
 * The engine had no spend ceiling of any kind: any number of executions, emails
 * and SMS per tenant, with providers billed per message. Throughput was shaped
 * only by a BullMQ `limiter`, which is per queue — that is, per platform — so one
 * tenant's burst delayed everyone else's messages for hours.
 */
describe('AutomationQuotaService', () => {
  const metrics = {
    recordQuotaRejection: jest.fn(),
  };

  const build = (counts: number[]) => {
    const eval_ = jest.fn();
    for (const count of counts) eval_.mockResolvedValueOnce(count);
    const redis = { eval: eval_ };
    return {
      service: new AutomationQuotaService(redis as any, metrics as any),
      redis,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AUTOMATION_TENANT_EXECUTIONS_PER_DAY = '2';
    process.env.AUTOMATION_TENANT_EMAILS_PER_MINUTE = '2';
    process.env.AUTOMATION_TENANT_EMAILS_PER_DAY = '3';
  });

  afterAll(() => {
    delete process.env.AUTOMATION_TENANT_EXECUTIONS_PER_DAY;
    delete process.env.AUTOMATION_TENANT_EMAILS_PER_MINUTE;
    delete process.env.AUTOMATION_TENANT_EMAILS_PER_DAY;
  });

  it('should allow work up to the limit and refuse the one after it', async () => {
    const { service } = build([1, 2, 3]);

    await expect(service.consumeExecution('t1')).resolves.toMatchObject({
      allowed: true,
    });
    await expect(service.consumeExecution('t1')).resolves.toMatchObject({
      allowed: true,
    });

    const third = await service.consumeExecution('t1');
    expect(third.allowed).toBe(false);
    expect(third.kind).toBe('execution_daily');
    expect(third.transient).toBe(false);
    expect(metrics.recordQuotaRejection).toHaveBeenCalledWith(
      'execution_daily',
      't1',
    );
  });

  it('should scope counters per tenant', async () => {
    const { service, redis } = build([1, 1]);

    await service.consumeExecution('tenant-a');
    await service.consumeExecution('tenant-b');

    const keyA = redis.eval.mock.calls[0][2];
    const keyB = redis.eval.mock.calls[1][2];
    expect(keyA).toContain('tenant-a');
    expect(keyB).toContain('tenant-b');
    expect(keyA).not.toBe(keyB);
  });

  it('should report a per-minute rate as transient and a daily cap as not', async () => {
    const { service } = build([3]);
    const rate = await service.consumeMessage('t1', 'email');
    expect(rate.allowed).toBe(false);
    expect(rate.kind).toBe('email_rate');
    // Waiting helps: the minute bucket rolls over.
    expect(rate.transient).toBe(true);

    const { service: service2 } = build([1, 4]);
    const daily = await service2.consumeMessage('t1', 'email');
    expect(daily.allowed).toBe(false);
    expect(daily.kind).toBe('email_daily');
    expect(daily.transient).toBe(false);
  });

  it('should check the rate before the daily allowance', async () => {
    // A tenant that is merely bursting must not burn a day's allowance on
    // messages the rate limit will refuse anyway.
    const { service, redis } = build([3]);

    await service.consumeMessage('t1', 'email');

    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval.mock.calls[0][2]).toContain('email_rate');
  });

  it('should fail closed when Redis is unavailable', async () => {
    const redis = { eval: jest.fn().mockRejectedValue(new Error('no redis')) };
    const service = new AutomationQuotaService(redis as any, metrics as any);

    const decision = await service.consumeMessage('t1', 'sms');

    // A quota that fails open is not a quota, and for money the permissive
    // direction is the expensive one.
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/QUOTA_UNAVAILABLE/);
    expect(decision.transient).toBe(true);
  });

  it('should treat a limit of 0 as disabled without touching Redis', async () => {
    process.env.AUTOMATION_TENANT_EXECUTIONS_PER_DAY = '0';
    const redis = { eval: jest.fn() };
    const service = new AutomationQuotaService(redis as any, metrics as any);

    await expect(service.consumeExecution('t1')).resolves.toMatchObject({
      allowed: true,
    });
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
