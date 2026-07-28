/* eslint-disable @typescript-eslint/require-await */
import { ZsetReservationService } from './zset-reservation.service';

describe('ZsetReservationService command leases', () => {
  const redis = {
    get: jest.fn(async (): Promise<string | null> => null),
    expire: jest.fn(async () => 1),
    eval: jest.fn(async () => 'u1'),
    del: jest.fn(async () => 1),
  };
  const cursor = { advance: jest.fn(async () => undefined) };

  beforeEach(() => jest.clearAllMocks());

  it('should reuse a command lease without incrementing workload again', async () => {
    redis.get.mockResolvedValueOnce('u1');
    const service = new ZsetReservationService(redis as any, cursor as any);
    const selected = await service.reserve(
      { loadScope: 't:Ticket', cursorScope: 'c', commandId: 'cmd1' },
      ['u1', 'u2'],
      'round-robin',
      10,
    );
    expect(selected).toBe('u1');
    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.expire).toHaveBeenCalledWith('assign:lease:cmd1', 600);
  });

  it('should create the lease atomically inside the reservation script', async () => {
    const service = new ZsetReservationService(redis as any, cursor as any);
    await service.reserve(
      { loadScope: 't:Ticket', cursorScope: 'c', commandId: 'cmd1' },
      ['u1'],
      'capacity-based',
      10,
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      'assign:load:t:Ticket',
      '',
      'assign:lease:cmd1',
      '1',
      'u1',
      '10',
      '600',
    );
  });
});
