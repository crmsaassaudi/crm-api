import { CallHandler, ExecutionContext } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { RedisService } from '../../redis/redis.service';

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let redisService: jest.Mocked<RedisService>;
  let redisClient: {
    set: jest.Mock;
    del: jest.Mock;
    exists: jest.Mock;
  };

  beforeEach(() => {
    redisClient = {
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      exists: jest.fn(),
    };

    redisService = {
      getClient: jest.fn().mockReturnValue(redisClient),
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn(),
    } as any;

    interceptor = new IdempotencyInterceptor(redisService);
  });

  it('should cache successful responses and release the processing lock', async () => {
    redisService.get.mockResolvedValue(undefined);
    redisClient.set.mockResolvedValue('OK');

    const observable = await interceptor.intercept(
      createContext('abc'),
      createHandler({ ok: true }),
    );

    await expect(lastValueFrom(observable)).resolves.toEqual({ ok: true });
    expect(redisService.set).toHaveBeenCalledWith(
      'idmp:abc',
      { ok: true },
      7200,
    );
    expect(redisClient.del).toHaveBeenCalledWith('lock:idmp:abc');
  });

  it('should return cached response when duplicate request finishes while waiting', async () => {
    redisService.get
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ok: true });
    redisClient.set.mockResolvedValue(null);

    const observable = await interceptor.intercept(
      createContext('abc'),
      createHandler({ shouldNotRun: true }),
    );

    await expect(lastValueFrom(observable)).resolves.toEqual({ ok: true });
    expect(redisClient.set).toHaveBeenCalledTimes(1);
  });

  it('should process a duplicate request when the original lock ended without cache', async () => {
    redisService.get.mockResolvedValue(undefined);
    redisClient.set.mockResolvedValueOnce(null).mockResolvedValueOnce('OK');
    redisClient.exists.mockResolvedValue(0);

    const observable = await interceptor.intercept(
      createContext('abc'),
      createHandler({ recovered: true }),
    );

    await expect(lastValueFrom(observable)).resolves.toEqual({
      recovered: true,
    });
    expect(redisClient.set).toHaveBeenCalledTimes(2);
    expect(redisService.set).toHaveBeenCalledWith(
      'idmp:abc',
      { recovered: true },
      7200,
    );
  });

  it('should still reject duplicates when the first request is processing after the wait window', async () => {
    jest
      .spyOn<any, any>(interceptor, 'waitForCachedResponse')
      .mockResolvedValue({
        status: 'processing',
      });
    redisService.get.mockResolvedValue(undefined);
    redisClient.set.mockResolvedValue(null);

    await expect(
      interceptor.intercept(createContext('abc'), createHandler({ ok: false })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  function createContext(idempotencyKey: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-idempotency-key': idempotencyKey },
        }),
      }),
    } as ExecutionContext;
  }

  function createHandler(response: any): CallHandler {
    return {
      handle: jest.fn(() => of(response)),
    };
  }
});
