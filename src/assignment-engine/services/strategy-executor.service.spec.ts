import { StrategyExecutorService } from './strategy-executor.service';

describe('StrategyExecutorService', () => {
  let redis: {
    incr: jest.Mock;
    expire: jest.Mock;
    pipeline: jest.Mock;
    eval: jest.Mock;
  };
  let pipeline: {
    zadd: jest.Mock;
    expire: jest.Mock;
    exec: jest.Mock;
  };
  let service: StrategyExecutorService;

  beforeEach(() => {
    pipeline = {
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    redis = {
      incr: jest.fn(),
      expire: jest.fn(),
      pipeline: jest.fn().mockReturnValue(pipeline),
      eval: jest.fn().mockResolvedValue(['agent_a', '0']),
    };
    service = new StrategyExecutorService(redis as any);
  });

  it('should reserve least-busy candidates atomically in Redis', async () => {
    const result = await service.leastBusyAtomic(
      'tenant_1:Ticket:team_1',
      new Map([
        ['agent_a', 0],
        ['agent_b', 2],
      ]),
    );

    expect(result).toEqual({ candidateId: 'agent_a', load: 0 });
    expect(pipeline.zadd).toHaveBeenCalledWith(
      'assign:load:tenant_1:Ticket:team_1',
      'NX',
      0,
      'agent_a',
    );
    expect(pipeline.zadd).toHaveBeenCalledWith(
      'assign:load:tenant_1:Ticket:team_1',
      'NX',
      2,
      'agent_b',
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'assign:load:tenant_1:Ticket:team_1',
      '2',
      'agent_a',
      'agent_b',
    );
  });

  it('should reject empty least-busy pools', async () => {
    await expect(
      service.leastBusyAtomic('tenant_1:Ticket:team_1', new Map()),
    ).rejects.toThrow('Least-busy called with empty load map');
  });
});
