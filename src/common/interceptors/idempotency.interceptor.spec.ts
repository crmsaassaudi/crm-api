import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
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
      'idmp:user:user_1:abc',
      {
        __idempotencyCache: true,
        type: 'success',
        body: { ok: true },
      },
      7200,
    );
    expect(redisClient.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'lock:idmp:user:user_1:abc',
      expect.any(String),
    );
  });

  it('should scope the same idempotency key by user', async () => {
    redisService.get.mockResolvedValue(undefined);
    redisClient.set.mockResolvedValue('OK');

    await lastValueFrom(
      await interceptor.intercept(
        createContext('abc', 'user_a'),
        createHandler({ ok: 'a' }),
      ),
    );
    await lastValueFrom(
      await interceptor.intercept(
        createContext('abc', 'user_b'),
        createHandler({ ok: 'b' }),
      ),
    );

    expect(redisService.set).toHaveBeenNthCalledWith(
      1,
      'idmp:user:user_a:abc',
      expect.objectContaining({ type: 'success' }),
      7200,
    );
    expect(redisService.set).toHaveBeenNthCalledWith(
      2,
      'idmp:user:user_b:abc',
      expect.objectContaining({ type: 'success' }),
      7200,
    );
  });

  it('should return cached response when duplicate request finishes before fail-fast check', async () => {
    redisService.get.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      __idempotencyCache: true,
      type: 'success',
      body: { ok: true },
    });
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
      'lock:idmp:user:user_1:abc',
      expect.any(String),
    );
  });

  it('should cache deterministic 4xx errors with a short TTL', async () => {
    redisService.get.mockResolvedValue(undefined);
    redisClient.set.mockResolvedValue('OK');
    const error = new BadRequestException('invalid payload');

    const observable = await interceptor.intercept(createContext('abc'), {
      handle: jest.fn(() => throwError(() => error)),
    });

    await expect(lastValueFrom(observable)).rejects.toBe(error);
    expect(redisService.set).toHaveBeenCalledWith(
      'idmp:user:user_1:abc',
      {
        __idempotencyCache: true,
        type: 'error',
        statusCode: 400,
        body: error.getResponse(),
      },
      120,
    );
  });

  it('should replay cached 4xx errors without running the handler', async () => {
    redisService.get.mockResolvedValueOnce({
      __idempotencyCache: true,
      type: 'error',
      statusCode: 400,
      body: { message: 'invalid payload' },
    });

    const handler = createHandler({ shouldNotRun: true });
    const observable = await interceptor.intercept(
      createContext('abc'),
      handler,
    );

    await expect(lastValueFrom(observable)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('should not cache 5xx errors', async () => {
    redisService.get.mockResolvedValue(undefined);
    redisClient.set.mockResolvedValue('OK');
    const error = new InternalServerErrorException('boom');

    const observable = await interceptor.intercept(createContext('abc'), {
      handle: jest.fn(() => throwError(() => error)),
    });

    await expect(lastValueFrom(observable)).rejects.toBe(error);
    expect(redisService.set).not.toHaveBeenCalled();
    expect(redisClient.eval).toHaveBeenCalledTimes(1);
  });

  it('should pass through when idempotency key is missing', async () => {
    const handler = createHandler({ ok: true });

    const observable = await interceptor.intercept(
      createContext(undefined),
      handler,
    );

    await expect(lastValueFrom(observable)).resolves.toEqual({ ok: true });
    expect(redisClient.set).not.toHaveBeenCalled();
    expect(redisService.set).not.toHaveBeenCalled();
  });

  function createContext(
    idempotencyKey: string | undefined,
    userId = 'user_1',
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: idempotencyKey
            ? { 'x-idempotency-key': idempotencyKey }
            : {},
          user: { userId },
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
