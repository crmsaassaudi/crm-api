import { UnauthorizedException } from '@nestjs/common';
import { InternalApiKeyGuard } from './internal-api-key.guard';

describe('InternalApiKeyGuard', () => {
  const key = 'a-strong-internal-key';

  const contextWith = (headers: Record<string, unknown>) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    }) as any;

  const buildGuard = (configured?: string) => {
    const cls = { set: jest.fn() };
    const guard = new InternalApiKeyGuard(
      { get: () => configured } as any,
      cls as any,
    );
    return { guard, cls };
  };

  it('should reject every request when INTERNAL_API_KEY is unset, whatever NODE_ENV says', () => {
    // The regression this guards: keying the skip on NODE_ENV !== 'production'
    // exposed tenant provisioning and feature-permission grants whenever the
    // variable was simply not set.
    const previous = process.env.NODE_ENV;
    for (const nodeEnv of ['development', 'test', undefined]) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;

      const { guard } = buildGuard(undefined);
      expect(() =>
        guard.canActivate(contextWith({ 'x-internal-api-key': key })),
      ).toThrow(UnauthorizedException);
    }
    process.env.NODE_ENV = previous;
  });

  it('should reject a missing or wrong key', () => {
    const { guard } = buildGuard(key);
    expect(() => guard.canActivate(contextWith({}))).toThrow(
      UnauthorizedException,
    );
    expect(() =>
      guard.canActivate(contextWith({ 'x-internal-api-key': 'wrong-length' })),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(
        contextWith({ 'x-internal-api-key': 'a'.repeat(key.length) }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('should accept the configured key and mark the request as API-key-initiated', () => {
    const { guard, cls } = buildGuard(key);
    expect(guard.canActivate(contextWith({ 'x-internal-api-key': key }))).toBe(
      true,
    );
    expect(cls.set).toHaveBeenCalledWith('executionSource', 'A');
  });
});
