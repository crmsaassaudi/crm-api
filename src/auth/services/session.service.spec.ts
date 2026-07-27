import { SessionService } from './session.service';

describe('SessionService', () => {
  let ioredis: any;
  let service: SessionService;

  beforeEach(() => {
    ioredis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue([]),
      expire: jest.fn().mockResolvedValue(1),
      publish: jest.fn().mockResolvedValue(1),
      duplicate: jest.fn(),
    };
    service = new SessionService(ioredis);
  });

  const tokens = {
    access_token: 'a',
    refresh_token: 'r',
    id_token: 'i',
    expires_in: 3600,
  };

  describe('createSession', () => {
    it('should index the session under the user so it can be revoked later', async () => {
      const sid = await service.createSession(tokens, 'user_1');

      expect(ioredis.sadd).toHaveBeenCalledWith('session:byuser:user_1', sid);
      expect(ioredis.expire).toHaveBeenCalledWith(
        'session:byuser:user_1',
        86_400,
      );
    });
  });

  describe('deleteSession', () => {
    it('should remove the sid from the user index when found in Redis', async () => {
      ioredis.get.mockResolvedValueOnce(
        JSON.stringify({ userId: 'user_1', ...tokens }),
      );

      await service.deleteSession('sid_1');

      expect(ioredis.srem).toHaveBeenCalledWith(
        'session:byuser:user_1',
        'sid_1',
      );
      expect(ioredis.del).toHaveBeenCalledWith('session:sid_1');
    });

    it('should still delete the session key even when the user cannot be resolved', async () => {
      ioredis.get.mockResolvedValueOnce(null);

      await service.deleteSession('sid_orphan');

      expect(ioredis.del).toHaveBeenCalledWith('session:sid_orphan');
      expect(ioredis.srem).not.toHaveBeenCalled();
    });
  });

  describe('deleteAllSessionsForUser', () => {
    it('should delete every indexed session and the index itself', async () => {
      ioredis.smembers.mockResolvedValueOnce(['sid_1', 'sid_2']);
      ioredis.get.mockResolvedValue(
        JSON.stringify({ userId: 'user_1', ...tokens }),
      );

      await service.deleteAllSessionsForUser('user_1');

      expect(ioredis.del).toHaveBeenCalledWith('session:sid_1');
      expect(ioredis.del).toHaveBeenCalledWith('session:sid_2');
      expect(ioredis.del).toHaveBeenCalledWith('session:byuser:user_1');
    });

    it('should no-op cleanly when the user has no live sessions', async () => {
      ioredis.smembers.mockResolvedValueOnce([]);

      await service.deleteAllSessionsForUser('user_with_no_sessions');

      expect(ioredis.del).toHaveBeenCalledWith(
        'session:byuser:user_with_no_sessions',
      );
    });
  });
});
