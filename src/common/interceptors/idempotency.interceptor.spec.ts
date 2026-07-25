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

/**
 * IdempotencyInterceptor.
 *
 * This suite was rewritten against the current implementation. The previous
 * version asserted an older design — a `GET` for the cache followed by a
 * `SET NX` for the lock, with keys `idmp:…` / `lock:idmp:…`. The interceptor has
 * since become a single atomic Lua check-and-lock with Redis-Cluster hash tags
 * (`{idmp:…}` / `{idmp:…}:lock`). The old mocks made `eval` resolve `1`, which
 * the current code reads as "a cached value was found", so every test replayed
 * the number 1 instead of the handler's response.
 *
 * Worth being precise about what that meant: the suite was not merely failing,
 * it was providing NO coverage of a concurrency-critical path — the one that
 * decides whether a retried payment or a double-submitted form runs twice.
 *
 * The contract now under test is the Lua script's three-valued return:
 *   null            → lock acquired, run the handler
 *   'LOCKED'        → someone else holds the lock, reject with 409
 *   <JSON string>   → a cached envelope, replay it without running the handler
 */
describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let redisService: jest.Mocked<RedisService>;
  let redisClient: { eval: jest.Mock };

  /** Calls to the check-and-lock script (2 keys), in order. */
  let checkAndLockCalls: unknown[][];
  /** Calls to the lock-release script (1 key), in order. */
  let releaseCalls: unknown[][];

  const KEY = '{idmp:user:user_1:abc}';
  const LOCK_KEY = `${KEY}:lock`;

  /**
   * Both operations go through `client.eval`, so they are told apart by the
   * numkeys argument the interceptor passes: 2 for check-and-lock, 1 for
   * release. Asserting on that split is deliberate — it is the only way to
   * verify the lock is released without reaching into the Lua source.
   */
  const arrangeEval = (checkAndLockResult: unknown) => {
    redisClient.eval.mockImplementation((...args: unknown[]) => {
      if (args[1] === 2) {
        checkAndLockCalls.push(args);
        return Promise.resolve(checkAndLockResult);
      }
      releaseCalls.push(args);
      return Promise.resolve(1);
    });
  };

  beforeEach(() => {
    checkAndLockCalls = [];
    releaseCalls = [];
    redisClient = { eval: jest.fn() };

    redisService = {
      getClient: jest.fn().mockReturnValue(redisClient),
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn(),
    } as any;

    interceptor = new IdempotencyInterceptor(redisService);
  });

  describe('first request — lock acquired', () => {
    it('should cache the successful response and release the lock', async () => {
      arrangeEval(null);

      const observable = await interceptor.intercept(
        createContext('abc'),
        createHandler({ ok: true }),
      );

      await expect(lastValueFrom(observable)).resolves.toEqual({ ok: true });
      expect(redisService.set).toHaveBeenCalledWith(
        KEY,
        {
          __idempotencyCache: true,
          type: 'success',
          body: { ok: true },
        },
        7200,
      );
      expect(releaseCalls).toHaveLength(1);
      expect(releaseCalls[0][2]).toBe(LOCK_KEY);
    });

    it('should key the lock inside the same hash tag as the cache entry', async () => {
      // Both keys must land in one Redis Cluster slot or the two-key Lua script
      // fails with CROSSSLOT — in a single-node dev setup that failure is
      // invisible, and it appears only once someone runs a cluster.
      arrangeEval(null);

      await lastValueFrom(
        await interceptor.intercept(
          createContext('abc'),
          createHandler({ ok: true }),
        ),
      );

      const [, , cacheKey, lockKey] = checkAndLockCalls[0];
      expect(cacheKey).toBe(KEY);
      expect(lockKey).toBe(LOCK_KEY);
      expect(String(lockKey).startsWith(String(cacheKey))).toBe(true);
    });

    it('should pass a unique lock value so release cannot free another owner lock', async () => {
      arrangeEval(null);

      await lastValueFrom(
        await interceptor.intercept(
          createContext('abc'),
          createHandler({ ok: 1 }),
        ),
      );
      const first = checkAndLockCalls[0][4];

      checkAndLockCalls = [];
      releaseCalls = [];
      arrangeEval(null);
      await lastValueFrom(
        await interceptor.intercept(
          createContext('abc'),
          createHandler({ ok: 2 }),
        ),
      );
      const second = checkAndLockCalls[0][4];

      expect(first).toEqual(expect.any(String));
      expect(first).not.toEqual(second);
      // The release script is handed the same value, which is what makes it
      // check ownership rather than deleting whatever lock is currently there.
      expect(releaseCalls[0][3]).toBe(second);
    });
  });

  describe('scoping', () => {
    it('should scope the same idempotency key by user', async () => {
      // Without this, one user's key collides with another's and the second
      // caller is served the first caller's response body.
      arrangeEval(null);

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
        '{idmp:user:user_a:abc}',
        expect.objectContaining({ type: 'success' }),
        7200,
      );
      expect(redisService.set).toHaveBeenNthCalledWith(
        2,
        '{idmp:user:user_b:abc}',
        expect.objectContaining({ type: 'success' }),
        7200,
      );
    });

    it('should fall back to a request fingerprint for an anonymous caller', async () => {
      // An anonymous caller must still be scoped to something. Keying on the
      // bare header would let any client replay — or block — a stranger's
      // request by guessing the key.
      arrangeEval(null);

      const context = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {
              'x-idempotency-key': 'abc',
              'user-agent': 'jest',
              'x-forwarded-for': '10.0.0.1',
            },
          }),
        }),
      } as ExecutionContext;

      await lastValueFrom(
        await interceptor.intercept(context, createHandler({ ok: true })),
      );

      const [, , cacheKey] = checkAndLockCalls[0];
      expect(String(cacheKey)).toMatch(/^\{idmp:anonymous:[0-9a-f]{32}:abc\}$/);
    });
  });

  describe('duplicate request — cache hit or lock contention', () => {
    it('should replay a cached success without running the handler', async () => {
      arrangeEval(
        JSON.stringify({
          __idempotencyCache: true,
          type: 'success',
          body: { ok: true },
        }),
      );

      const handler = createHandler({ shouldNotRun: true });
      const observable = await interceptor.intercept(
        createContext('abc'),
        handler,
      );

      await expect(lastValueFrom(observable)).resolves.toEqual({ ok: true });
      expect(handler.handle).not.toHaveBeenCalled();
      // No lock was taken, so none may be released — releasing here would free
      // the lock held by the in-flight original.
      expect(releaseCalls).toHaveLength(0);
      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('should REJECT with 409 while the original is still processing', async () => {
      arrangeEval('LOCKED');

      const handler = createHandler({ ok: false });
      await expect(
        interceptor.intercept(createContext('abc'), handler),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(handler.handle).not.toHaveBeenCalled();
      expect(releaseCalls).toHaveLength(0);
    });

    it('should replay a cached 4xx error without running the handler', async () => {
      arrangeEval(
        JSON.stringify({
          __idempotencyCache: true,
          type: 'error',
          statusCode: 400,
          body: { message: 'invalid payload' },
        }),
      );

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

    it('should replay an unrecognised cached value as-is rather than throwing', async () => {
      // A payload written by an older version, or by something else entirely.
      // Total behaviour matters here: an interceptor that throws on a
      // malformed cache entry turns one bad key into a permanently broken
      // endpoint for that caller until the TTL expires.
      arrangeEval('not json at all');

      const observable = await interceptor.intercept(
        createContext('abc'),
        createHandler({ shouldNotRun: true }),
      );

      await expect(lastValueFrom(observable)).resolves.toBe('not json at all');
    });
  });

  describe('handler failure', () => {
    it('should release the lock when the handler throws', async () => {
      arrangeEval(null);
      const error = new Error('boom');

      const observable = await interceptor.intercept(createContext('abc'), {
        handle: jest.fn(() => throwError(() => error)),
      });

      await expect(lastValueFrom(observable)).rejects.toThrow('boom');
      expect(releaseCalls).toHaveLength(1);
      expect(releaseCalls[0][2]).toBe(LOCK_KEY);
    });

    it('should cache a deterministic 4xx error with a short TTL', async () => {
      // A rejected payload will be rejected again, so replaying it is correct
      // and cheap. The short TTL is what keeps a fixed client from being stuck
      // with a stale rejection.
      arrangeEval(null);
      const error = new BadRequestException('invalid payload');

      const observable = await interceptor.intercept(createContext('abc'), {
        handle: jest.fn(() => throwError(() => error)),
      });

      await expect(lastValueFrom(observable)).rejects.toBe(error);
      expect(redisService.set).toHaveBeenCalledWith(
        KEY,
        {
          __idempotencyCache: true,
          type: 'error',
          statusCode: 400,
          body: error.getResponse(),
        },
        120,
      );
    });

    it('should NOT cache a 5xx error', async () => {
      // A 500 may be transient. Caching it would convert a blip into a
      // guaranteed failure for every retry of that key.
      arrangeEval(null);
      const error = new InternalServerErrorException('boom');

      const observable = await interceptor.intercept(createContext('abc'), {
        handle: jest.fn(() => throwError(() => error)),
      });

      await expect(lastValueFrom(observable)).rejects.toBe(error);
      expect(redisService.set).not.toHaveBeenCalled();
      expect(releaseCalls).toHaveLength(1);
    });

    it('should NOT cache a 409, so a retry is not permanently blocked', async () => {
      arrangeEval(null);
      const error = new ConflictException('already processing');

      const observable = await interceptor.intercept(createContext('abc'), {
        handle: jest.fn(() => throwError(() => error)),
      });

      await expect(lastValueFrom(observable)).rejects.toBe(error);
      expect(redisService.set).not.toHaveBeenCalled();
    });
  });

  describe('pass-through', () => {
    it('should pass through when the idempotency key is missing', async () => {
      const handler = createHandler({ ok: true });

      const observable = await interceptor.intercept(
        createContext(undefined),
        handler,
      );

      await expect(lastValueFrom(observable)).resolves.toEqual({ ok: true });
      expect(redisClient.eval).not.toHaveBeenCalled();
      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('should pass through when the idempotency key is blank', async () => {
      // A header present but empty is a client bug, not an instruction to key
      // every such request together — which is what trimming to '' and
      // proceeding would do.
      const handler = createHandler({ ok: true });

      const observable = await interceptor.intercept(
        createContext('   '),
        handler,
      );

      await expect(lastValueFrom(observable)).resolves.toEqual({ ok: true });
      expect(redisClient.eval).not.toHaveBeenCalled();
    });
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
