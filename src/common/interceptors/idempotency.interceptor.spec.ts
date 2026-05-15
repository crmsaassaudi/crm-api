import { CallHandler, ExecutionContext } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { RedisService } from '../../redis/redis.service';

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let redisService: jest.Mocked<RedisService>;
  let redisClient: {
    set: jest.Mock;
    eval: jest.Mock;
  };

  beforeEach(() => {
    redisClient = {
      set: jest.fn(),
      eval: jest.fn().mockResolvedValue(1),
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
    expect(redisClient.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'lock:idmp:abc',
      expect.any(String),
    );
  });

  it('should return cached response when duplicate request finishes before fail-fast check', async () => {
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

  it('should reject a duplicate request when the original is still processing', async () => {
    redisService.get.mockResolvedValue(undefined);
    redisClient.set.mockResolvedValue(null);

    await expect(
      interceptor.intercept(createContext('abc'), createHandler({ ok: false })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(redisClient.set).toHaveBeenCalledTimes(1);
  });

  it('should release only the lock owned by this request when handler fails', async () => {
    redisService.get.mockResolvedValue(undefined);
    redisClient.set.mockResolvedValue('OK');
    const error = new Error('boom');

    const observable = await interceptor.intercept(createContext('abc'), {
      handle: jest.fn(() => throwError(() => error)),
    });

    await expect(lastValueFrom(observable)).rejects.toThrow('boom');
    expect(redisClient.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'lock:idmp:abc',
      expect.any(String),
    );
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
