import { lastValueFrom, of } from 'rxjs';
import { applyMask, maskValue } from './field-sensitivity.registry';
import { FieldMaskingInterceptor } from './field-masking.interceptor';
import { PrincipalType } from './principal';

describe('field-sensitivity strategies', () => {
  it('masks email keeping first char + domain', () => {
    expect(applyMask('alice@example.com', 'email')).toBe('a••••@example.com');
  });
  it('masks phone keeping last 4', () => {
    expect(applyMask('+1 415 555 1234', 'phone')).toBe('••••1234');
  });
  it('is idempotent (already-masked stays masked)', () => {
    const once = applyMask('alice@example.com', 'email');
    expect(applyMask(once, 'email')).toBe(once);
  });
  it('maskValue handles arrays of strings', () => {
    expect(maskValue(['a@b.com', 'c@d.com'], 'email')).toEqual([
      applyMask('a@b.com', 'email'),
      applyMask('c@d.com', 'email'),
    ]);
    // non-string members pass through untouched
    expect(maskValue([1, 'a@b.com'], 'email')).toEqual([
      1,
      applyMask('a@b.com', 'email'),
    ]);
  });
});

describe('FieldMaskingInterceptor', () => {
  let reflector: any;
  let authz: any;
  let cls: any;
  let interceptor: FieldMaskingInterceptor;

  const handlerReturning = (data: any) => ({ handle: () => of(data) });
  const ctx = () =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user: { userId: 'u1', tenantId: 't1' } }),
      }),
    }) as any;

  beforeEach(() => {
    reflector = { get: jest.fn() };
    authz = { canPerformAction: jest.fn() };
    cls = {
      get: jest.fn((k: string) =>
        k === 'userId' ? 'u1' : k === 'tenantId' ? 't1' : undefined,
      ),
    };
    interceptor = new FieldMaskingInterceptor(reflector, authz, cls);
  });

  it('is a no-op when the handler has no @SensitiveResource', async () => {
    reflector.get.mockReturnValue(undefined);
    const out = await lastValueFrom(
      interceptor.intercept(
        ctx(),
        handlerReturning({ email: 'a@b.com' }),
      ),
    );
    expect(out).toEqual({ email: 'a@b.com' });
    expect(authz.canPerformAction).not.toHaveBeenCalled();
  });

  it('masks PII when the principal lacks the unmask permission', async () => {
    reflector.get.mockReturnValue('contacts');
    authz.canPerformAction.mockResolvedValue({ allowed: false });

    const out = await lastValueFrom(
      interceptor.intercept(
        ctx(),
        handlerReturning({ id: '1', email: 'alice@example.com', phone: '4155551234' }),
      ),
    );
    expect(out.email).toBe('a••••@example.com');
    expect(out.phone).toBe('••••1234');
  });

  it('leaves PII intact when the principal holds the unmask permission', async () => {
    reflector.get.mockReturnValue('contacts');
    authz.canPerformAction.mockResolvedValue({ allowed: true });

    const out = await lastValueFrom(
      interceptor.intercept(
        ctx(),
        handlerReturning({ id: '1', email: 'alice@example.com', phone: '4155551234' }),
      ),
    );
    expect(out.email).toBe('alice@example.com');
    expect(out.phone).toBe('4155551234');
    // Both contact fields share one unmask permission → evaluated once.
    expect(authz.canPerformAction).toHaveBeenCalledTimes(1);
  });

  it('ALWAYS masks for an agent principal without any PDP call', async () => {
    reflector.get.mockReturnValue('contacts');
    cls.get.mockImplementation((k: string) =>
      k === 'userId'
        ? 'u1'
        : k === 'tenantId'
          ? 't1'
          : k === 'principalType'
            ? PrincipalType.AGENT
            : undefined,
    );

    const out = await lastValueFrom(
      interceptor.intercept(
        ctx(),
        handlerReturning({ email: 'alice@example.com' }),
      ),
    );
    expect(out.email).toBe('a••••@example.com');
    expect(authz.canPerformAction).not.toHaveBeenCalled();
  });

  it('masks inside a paginated { data: [...] } payload', async () => {
    reflector.get.mockReturnValue('contacts');
    authz.canPerformAction.mockResolvedValue({ allowed: false });

    const out = await lastValueFrom(
      interceptor.intercept(
        ctx(),
        handlerReturning({
          data: [{ email: 'alice@example.com' }, { email: 'bob@x.io' }],
          hasNextPage: false,
        }),
      ),
    );
    expect(out.data[0].email).toBe('a••••@example.com');
    expect(out.data[1].email).toBe('b••@x.io');
    expect(out.hasNextPage).toBe(false);
  });
});
