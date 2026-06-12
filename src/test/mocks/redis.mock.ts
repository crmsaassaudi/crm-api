/**
 * Standard Redis mock for unit tests.
 * Provides a mock RedisService and a mock ioredis client.
 */
export function createRedisClientMock() {
  const pipeline = {
    del: jest.fn().mockReturnThis(),
    sadd: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };

  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    sismember: jest.fn().mockResolvedValue(0),
    pipeline: jest.fn().mockReturnValue(pipeline),
    scan: jest.fn().mockResolvedValue(['0', []]),
    eval: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
    ttl: jest.fn().mockResolvedValue(-2),
    expire: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1),
  };
}

export function createRedisServiceMock() {
  const client = createRedisClientMock();
  return {
    mock: {
      getClient: jest.fn().mockReturnValue(client),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(1),
    },
    client,
  };
}
